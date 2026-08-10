# Executor fleet status + monitoring plan — 2026-08-10

> Status: **live board snapshot + follow-up plan** (evening CST).  
> Evidence markers: `[E]` command/API/SSH; `[I]` inference; `[U]` unverified.

## 1. Current board (snapshot ~22:01 CST / 14:01 UTC) `[E]`

Control plane stays on MBP. Default execution stays on `mbp-executor-1`. Remotes are overflow / data-local / Windows canary.

| Layer | Component | State |
| --- | --- | --- |
| Control plane | gateway `:8080` | online, ready, pid managed |
| Control plane | local executor `:8090` | online, candidate |
| Channel | wechat-bot | process healthy; mode=disabled in status |
| Durable state | Postgres `127.0.0.1:55432` + Tailscale bind | sole truth surface |

### Fleet executors

| nodeId | Role | status | candidate | version | mem avail/total (MB) | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `mbp-executor-1` | **default** | online | true | `0.1.0+b155625e98013` | ~22G / 32G | macos-sandbox; primary interactive path |
| `node34-executor-1` | pinned / NAS-local | online | true | `0.1.0+b98714c660d7c` | ~4.7G / 9.9G | linux-bwrap; path flaps → false offline history |
| `oracle-executor` | overflow light | online | true | `0.1.0+b98714c660d7c` | ~0.4G / 0.95G | **low RAM**; bind fixed tonight |
| `desktop-r45553o` | Windows canary | online | true | `0.1.0+b155625e98013` | ~25G / 28G | first durable deploy tonight |

`runtime-health`: `overall=ok`, `candidates=4`, `online=4`, no blockers/warnings.  
Registry still lists non-fleet rows (`oracle-t`, `localnode34`, …) — ssh_target / historical; not candidates.

### Enabled schedules (supervision-related)

| Title | Template | Cadence intent |
| --- | --- | --- |
| dogfood runtime readiness check | `runtime_readiness` | ~15m fleet attention board |
| gateway/executor log freshness (V3) | `runtime_readiness` | log mtime (weak signal) |
| NAS34 drift check | `scheduled_execution` | daily-ish; needs real network on node34 |
| daily execution digest (WeChat) | `daily_execution_digest` | 08:30 local |
| surge / network-observe | `scheduled_execution` | domain analysis, not node health |

---

## 2. What changed tonight `[E]`

### 2.1 Rate-limited recovery (code, local jj)

- Gateway **auto-probe**: online + `run_agent` + only `verification:*:not_confirmed` → probe with caps **2/tick · 2s gap · 5m cooldown · 120s interval**.  
- `runtime-health` + readiness runner: **fleet** offline / online-unverified warnings (not only zero candidates).  
- Heartbeat **jitter**; file-sync list-refresh **backoff to 15m** on PG path outages.

### 2.2 `oracle-executor` bind fix

- Symptom: process healthy, local `/health` ok, remote probe **connection refused**.  
- Cause: missing `EXECUTOR_HOST` → default `127.0.0.1`.  
- Fix: `EXECUTOR_HOST=0.0.0.0` in `/opt/los/.env`, restart unit.  
- Result: listen `0.0.0.0:8091`, remote health + candidate=true.

### 2.3 `desktop-r45553o` Windows deploy (canary)

| Item | Value |
| --- | --- |
| Path | `C:\los` |
| Node URL | `http://100.90.170.58:8090` |
| Process | Scheduled Task **`los-executor`** (AtStartup + restart policy) |
| Start scripts | `C:\los\run-executor-task.ps1`, `install-task.ps1` |
| Firewall | `los-executor-8090` inbound TCP 8090 |
| PG | MBP `pg_hba`: `host los los 100.64.0.0/10 scram-sha-256` (Tailscale CGNAT) |
| Known gap | migration path WARN `packages\infra\packages\infra\migrations` (non-fatal); not a formal Windows service (nssm) yet |

SSH-attached process **dies when session ends** — Task Scheduler is required for durability.

### 2.4 node34 same-day lesson (earlier)

Registry offline while process healthy: Tailscale path timeout to MBP gateway/PG → reaper offline → hb recover without active probe → non-candidate until probe/auto-probe.

---

## 3. Placement policy (unchanged)

1. `default` → `mbp-executor-1`  
2. `pin(nodeId|nodeUrls)` → schedules (NAS34, data-local)  
3. capability → `linux-bwrap` node34; `macos-sandbox-exec` MBP; Windows experimental  
4. overflow light → oracle only when mem pressure allows  
5. Do **not** move control plane primary to NAS/Windows  

---

## 4. Monitoring / supervision plan (follow-up)

Goal: know **status + resources** per fleet node without request storms.

### 4.1 Truth surfaces (ordered)

| Priority | Surface | Use for |
| --- | --- | --- |
| 1 | DB / `GET /nodes` + `execution.candidate` | registry truth, capacity from heartbeat |
| 2 | `GET /ops/runtime-health` | aggregated degraded/critical board |
| 3 | Active probe `POST /nodes/:id/probe` | only on gap or cooldown expiry (auto-probe already) |
| 4 | Host process (`systemctl` / Task Scheduler / local health) | when registry disagrees with intent |
| 5 | Logs / journal | root-cause, not primary “is up” signal |

**Do not**: poll every node health URL every few seconds from schedules; rely on heartbeat capacity + rate-limited auto-probe.

### 4.2 Already in place (use as-is)

| Mechanism | Covers | Gap |
| --- | --- | --- |
| Heartbeat + stale reaper | process→gateway liveness | false offline on path flap |
| Auto-probe (gateway) | online-unverified → candidate | fails closed on dead remote health |
| `runtime-health` fleet warnings | offline fleet / online unverified | no resource thresholds yet |
| dogfood readiness | fleet offline/unverified summary | still succeeds (attention title), not WeChat |
| daily digest | day rollup | lag; not minute-level |
| Capacity on heartbeat | mem/cpu/load fields when reported | uneven across platforms; no alerts |

### 4.3 Recommended next work (priority order)

#### P0 — Node status supervision (low churn) — **Done** 2026-08-10

1. **Named fleet inventory** via `LOS_FLEET_NODE_IDS` (default four active executors).  
   Module: `packages/agent/src/fleet-inventory.ts`.  
2. **`/ops/runtime-health`**: `fleet` block + warnings `fleet:offline|online_unverified|missing`.  
3. **dogfood readiness** (`runtime_readiness` template): each tick updates `fleet_watch_state`; after **≥2 consecutive** unhealthy ticks emits `ops.fleet_attention` (SSE + WeChat), **30m/node cooldown**.  
4. Env: `LOS_FLEET_ALERT_CONSECUTIVE_TICKS`, `LOS_FLEET_ALERT_COOLDOWN_MS`.

#### P1 — Resource supervision (from heartbeat capacity, no extra probes) — **Done** 2026-08-10

Thresholds (starting defaults; tune after a week of data):

| Signal | Warning | Critical | Suggested action |
| --- | --- | --- | --- |
| `memoryAvailableMb / memoryTotalMb` | < 15% | < 5% (already blocks candidate) | drain / stop overflow to oracle |
| `cpuLoad1m / cpuCores` | > 2.0 | > 4.0 | avoid heavy pin |
| `swapUsedMb / swapTotalMb` (if present) | > 50% | > 80% | restart / free mem |
| `activeTaskCount` | > 0 on light/oracle (constrained or ≤2GB) | — | oracle is light-only |
| heartbeat age | > 45s | > 90s | path/gateway check |

Implementation (no storm):

- Module: `packages/agent/src/fleet-resources.ts` — pure eval from last heartbeat.  
- `getRuntimeHealth()` → `fleetResources` block + top-level `warnings[]` codes
  (`resource:memory_low|swap_high|…:<nodeId>`).  
- Live board: `GET /ops/runtime-health` (auth).  
- Daily digest section deferred: `daily-digest.ts` is at the 700-line gate; consume
  `fleetResources` / `formatFleetResourceSummary()` in a later extract.  
- Optional schedule template `fleet_resource_snapshot` still open (P2-ish).

#### P2 — Per-node host checks (bounded, pinned) — **Done** 2026-08-10

| Node | Check owner | Cadence | Command surface |
| --- | --- | --- | --- |
| node34 | `fleet_host_check` → ssh `localnode34-r-t` | ≥15m cooldown; schedule 6–12h | unit active, local health `:8090`, listen, free/swap |
| oracle | same → ssh `oracle-t` | same | unit active, local health `:8091`, listen, free/swap |
| desktop | same → ssh `win-los` | same | Task Scheduler `los-executor` status + local health `:8090` |
| mbp | dogfood + local los status | 15m | already covered (no SSH) |

Hard rate limits: **serial hosts**, **≥15m per host** (unless `--force`), fail soft.

Implementation:

- Modules: `fleet-host-checks.ts` + `fleet-host-check-ssh.ts`
- Template: `fleet_host_check` (governance, no provider)
- Manual: `./packages/gateway/node_modules/.bin/tsx tools/fleet-host-check.mts [--force|--dry-run]`
- Env: `LOS_FLEET_HOST_CHECKS` (see `.env.example`); `none` disables
- Alerts: `ops.fleet_host_check` session events, 30m/node cooldown

Create schedule (example, 6h interval) — live id may already exist:

```bash
curl -fsS -X POST \
  -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
  -H "x-los-auth-token: $LOS_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:8080/scheduled-work-items \
  -d '{
    "title":"fleet host check (remotes)",
    "templateId":"fleet_host_check",
    "trigger":{"kind":"interval","expression":"6h","timezone":"Asia/Shanghai"},
    "approvalPolicy":"read_only_auto"
  }'
```

Operator-created 2026-08-10: `schedule-d0388df2-cc54-4e37-a964-7035b96303f4` (enabled, 6h).

#### P3 — Operator UX — **partial** 2026-08-10

1. **Done**: fleet card on **Nodes** (full) and **Usage** (compact) —  
   `packages/web/src/fleet-card.tsx` reads `/ops/runtime-health`  
   (status · candidate · mem free% · swap% · heartbeat · findings).  
2. WeChat: only **state transitions** (candidate lost/restored), not every tick — still open.  
3. Daily digest: table of fleet rows from last heartbeat snapshot — deferred (700-line gate).

### 4.4 Explicit non-goals (for now)

- Moving gateway HA off MBP  
- Treating desktop as production default  
- Continuous active probing of all nodes  
- Merging external CI runner metrics into executor fleet board without labels  

---

## 5. Operator cheat sheet

```bash
# Board
curl -fsS -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" http://127.0.0.1:8080/ops/runtime-health | jq .
curl -fsS -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" http://127.0.0.1:8080/nodes \
  | jq -r '.[] | select(.execution.candidate or (.capabilities.run_agent==true and .nodeKind=="executor"))
    | [.nodeId,.status,(.execution.candidate|tostring),.version,.lastHeartbeatAt] | @tsv'

# One probe (manual; auto-probe also runs)
curl -fsS -X POST -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
  http://127.0.0.1:8080/nodes/<nodeId>/probe | jq '{status:.probe.status,candidate:.node.execution.candidate}'

# Host process truth
./tools/los.sh status
ssh localnode34-r-t 'systemctl is-active los-executor; curl -fsS http://127.0.0.1:8090/health'
ssh oracle-t 'systemctl is-active los-executor; ss -lntp | rg 8091; curl -fsS http://127.0.0.1:8091/health'
ssh win-los 'schtasks /Query /TN los-executor & curl -sS http://127.0.0.1:8090/health'
```

### Recover patterns

| Symptom | First check | Fix |
| --- | --- | --- |
| online, candidate=false, verification gap | auto-probe log / manual probe | wait cooldown or `POST …/probe` |
| remote health refused, local health ok | `ss`/`netstat` bind | set `EXECUTOR_HOST=0.0.0.0` |
| registry offline, process up | journal heartbeat timeouts | gateway up? Tailscale? PG path? |
| Windows dead after SSH start | Task Scheduler | `schtasks /Run /TN los-executor` |
| PG auth fail from remote | `pg_hba` | Tailscale `100.64.0.0/10` + scram |

---

## 6. Residual risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| MBP sleep / gateway down | high for all remotes | anti-sleep / second gateway (open) |
| oracle OOM (~1GB) | medium | light tasks only; mem warning in health |
| Windows task not “service-grade” | medium | nssm/service later; task restart policy now |
| migration path WARN on Windows | low | fix getMigrateDir for win paths |
| NAS34 schedule self-check false fail | medium | pin + non-sandbox network |
| Version skew (mbp/desktop vs node34/oracle) | low | redeploy remotes when shipping |
| node34 swap high from nmem growth | medium | see §8; nmem MemorySwapMax=1G |

---

## 7. Related

- `docs/operations/2026-08-10-control-plane-vs-executor-and-node-recovery.md`  
- `packages/gateway/src/node-auto-probe.ts`  
- `packages/agent/src/runtime-health.ts`  
- `packages/agent/src/fleet-inventory.ts`  
- `packages/agent/src/fleet-resources.ts`  
- `tools/deploy-to-remote.sh` (Linux)  
- Windows: `C:\los\run-executor-task.ps1`, task `los-executor`  

---

## 8. node34 swap incident — 2026-08-10 evening `[E]`

### Symptom

`resource:swap_high:node34-executor-1` on `/ops/runtime-health` — host swap ~67% used
(~4.0 / 5.9 GiB) while executor stayed `online` + `candidate=true`.

### Root cause (not los-executor)

| Process | Role | Before |
| --- | --- | --- |
| `nmem.service` (`nmem-server`) | Nowledge Mem on node34 | ~4.5 GiB RSS + **~3.1 GiB swap** (largest consumer) |
| `los-executor` | fleet executor | ~131 MiB; not the cause |
| residual | mysqld / bytebase / gnome | ~0.5 GiB swap after cleanup |

`nmem` drop-in previously set `MemoryHigh=4G` / `MemoryMax=6G` but
**`MemorySwapMax=infinity`**, so growth parked into host swap instead of being
capped. Pattern matches 2026-07 CI notes (nmem 2→4.8 GiB).

### Actions taken

1. Updated `/etc/systemd/system/nmem.service.d/memory-limit.conf`:
   `MemoryHigh=3G`, `MemoryMax=4G`, **`MemorySwapMax=1G`**.
2. `systemctl daemon-reload && systemctl restart nmem.service`.
3. Verified `nmem status ok`, `los-executor` still active, health `:8090` ok.

### Result (host, ~+5s after restart)

| Metric | Before | After |
| --- | --- | --- |
| Swap used | 4.0 GiB (~67%) | **1.0 GiB (~17%)** |
| Mem available | ~4.6 GiB | **~6.8 GiB** |
| nmem MemoryCurrent | ~3.4 GiB | ~1.1–1.9 GiB |
| nmem limits | high 4G / max 6G / swap ∞ | high 3G / max 4G / **swap 1G** |

### Operator notes

- Do **not** restart `los-executor` for this class of alert; inspect host swap
  consumers (`VmSwap` / `nmem.service`) first.
- Recurrence: if nmem hits MemoryMax/SwapMax and degrades, journal will show
  cgroup pressure; consider moving nmem off node34 or raising host RAM.
- API key may appear in nmem journal on start — treat as secret, do not paste.
