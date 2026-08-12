# Control plane vs executor placement + node recovery — 2026-08-10

> Status: **decision recorded + recovery applied** (same day).  
> Evidence markers: `[E]` command/DB/SSH; `[I]` inference; `[U]` unverified.

## 1. Architecture decision (do not move primary to NAS34)

### Judgment

**Do not relocate the “main agent” (control plane + default execution) to node34/NAS.**

| Layer | Role | Current home | Decision |
| --- | --- | --- | --- |
| Control plane | gateway, scheduler, governance, WeChat bot, operator SSE | MBP | Stay on MBP until HA gateway exists |
| Durable state | PostgreSQL `55432/los` | MBP | Stay; sole truth surface |
| Default execution | interactive chat, local workspace | `mbp-executor-1` | Stay default |
| Pinned / data-local execution | NAS-adjacent, linux-bwrap, long analysis | `node34-executor-1` | Recover + keep as **executor**, not primary |
| Overflow / low-resource | optional light tasks | `oracle-executor` | Recover when useful; not primary |

Rationale (summary of 2026-08-10 analysis):

1. Main operator path is still **single-agent + local monorepo** — remote default adds workspace drift cost without multi-agent need.
2. “Stability” problems were mostly **heartbeat/registry false offline**, gateway sleep/ECONNREFUSED, and code lag — not “MBP too weak.”
3. Industry direction (OpenClaw control plane, Claude-style loop, Temporal/LangGraph durable state): **split control plane vs workers**, durable state in DB, not “one big agent process on the NAS.”

### Placement policy (progressive)

1. `default` → local MBP executor  
2. `pin(nodeId|nodeUrls)` → schedule/template (already used for NAS34 drift)  
3. `capability` → e.g. `linux-bwrap` → node34; `macos-sandbox-exec` → MBP  
4. Later: overflow when local offline / queue high  

### Non-goals for now

- Moving gateway primary to node34  
- Multi-agent personality cluster  
- Cloud executors without workspace + secret contract  

---

## 2. Live inventory at recovery time `[E]`

Queried `executor_nodes` + Tailscale + SSH + `/health` (2026-08-10 ~15:20–15:36 CST).

### 2.1 Registry before recovery

| node_id | Registry | last_heartbeat | Process / network | Class |
| --- | --- | --- | --- | --- |
| mbp-executor-1 | online | fresh | local :8090 ok | **primary executor** |
| node34-executor-1 | offline (~1.7d) | 2026-08-08 22:10 | Tailscale active; **:8090 health ok**; systemd active | **recoverable — code lag** |
| oracle-executor | offline (~1.7d) | 2026-08-08 22:10 | Tailscale active; systemd; :8091 health when up | **recoverable — code lag + low RAM** |
| node34-ssh | offline 50d+ | Jun 20 | Duplicate identity of node34 agent_http | **retire / ignore** |
| localnode34 | offline 51d+ | Jun 20 | LAN 192.168.31.34 VM off | **park until LAN VM on** |
| oracle-t | offline 51d+ | Jun 20 | ssh_target row only | **metadata only** |
| desktop-r45553o | offline 52d+ | Jun 19 | Tailscale online; :8090 timeout | **optional — no los service** |
| tencent-sin-executor | offline 53d+ | Jun 17 | Host online; was dead-GATEWAY_URL crash history | **do not re-enable executor** (mesh/control role) |
| vultr-executor | offline 53d+ | Jun 17 | Host online; historical crash-loop | **do not re-enable** (DERP/proxy role) |
| test / test-heartbeat | offline | Jun | fixtures | **delete candidates** |

Gateway services: only `gateway-echers-mbp-local-8080` online.

### 2.2 Root cause of “online process, offline registry” `[E]`

On node34 and oracle **deployed source** (pre-sync):

```ts
// packages/executor/src/index.ts (remote, old)
await heartbeatNode(..., gatewayUrl, folders);  // no agentKey

// packages/executor/src/executor-heartbeat.ts (remote, old)
headers: { 'content-type': 'application/json' },  // no Authorization
```

Gateway requires:

```text
POST /nodes/heartbeat  Authorization: Bearer <EXECUTOR_AGENT_KEY>
```

When key is configured, missing Bearer → **401** `executor heartbeat authentication required`.

Evidence:

- Remote journal: consecutive 401 from 2026-08-09 onward after earlier ECONNREFUSED during gateway downtime  
- Manual `curl` with correct Bearer from node34 → **200**  
- `loadConfig()` + fetch with key on node34 → **200**  
- Disk `EXECUTOR_AGENT_KEY` sha matched MBP; **process env had key** but **code never sent it**

Secondary signals:

- Intermittent `GATEWAY_URL=http://100.112.77.123:8080` ECONNREFUSED when MBP gateway down/sleep  
- node34 file-sync DB timeouts when PG over Tailscale flakes  
- oracle ~1GB RAM: slow/failed restarts after sync  

Current MBP source **already** passes `agentKey` into `heartbeatNode` — remotes were simply **not redeployed**.

---

## 3. Recovery actions taken 2026-08-10 `[E]`

| Action | Result |
| --- | --- |
| Diagnose TS/SSH/health | node34 :8090 alive; oracle unit active |
| Identify missing Bearer on remote heartbeat | confirmed by reading `/opt/los/packages/executor/src/*` |
| `deploy-to-remote.sh 34 sync` + `restart` via `localnode34-r-t` | version → `0.1.0+b98714c660d7c`; registry **online** |
| `deploy-to-remote.sh oracle sync` + `restart` via `oracle-t` + sudo | version → `0.1.0+b98714c660d7c`; registry **online** after boot |
| Local mbp executor restart (version align) | keep primary fresh with current tree |

### Post-recovery check (target)

```sql
SELECT node_id, status, version, last_heartbeat_at
FROM executor_nodes
WHERE node_id IN ('mbp-executor-1','node34-executor-1','oracle-executor');
```

Expect all three `online` with fresh `last_heartbeat_at` and version ≥ deploy stamp.

### Deploy commands used

```bash
# node34
LOS_SSH_TRANSPORT=ssh LOS_SSH_TARGET=localnode34-r-t \
  bash tools/deploy-to-remote.sh 34 sync
LOS_SSH_TRANSPORT=ssh LOS_SSH_TARGET=localnode34-r-t \
  bash tools/deploy-to-remote.sh 34 restart

# oracle
LOS_SSH_TRANSPORT=ssh LOS_SSH_TARGET=oracle-t \
  LOS_REMOTE_USER=ubuntu LOS_REMOTE_PRIVILEGE=sudo \
  bash tools/deploy-to-remote.sh oracle sync
# same env: restart
```

---

## 4. Recovery classification (what to salvage)

| Class | Nodes | Action |
| --- | --- | --- |
| **A. Active executors** | mbp, node34, oracle | Keep online; **redeploy when heartbeat/auth contracts change** |
| **B. Intentional non-executors** | vultr, tencent-sin, nas, glkvm/miwifi | Mesh/proxy/storage only — **do not install executor** without role redesign |
| **C. Optional desktop** | desktop-r45553o | Recover only if Windows executor productized; else leave offline |
| **D. Stale identity rows** | node34-ssh, localnode34 (LAN), oracle-t ssh_target, test* | Document; optional registry cleanup (no auto-delete without consent) |
| **E. Parked hardware** | LAN VM 192.168.31.34 | Power on + re-register when needed |

---

## 5. Operational rules going forward

1. **After any gateway auth change** (`EXECUTOR_AGENT_KEY`, heartbeat middleware): redeploy **all** active remotes the same day.  
2. **Registry status is not process truth** — always pair with `curl :8090|/8091/health` + `systemctl` + journal.  
3. **Stale-online reaper** will flip registry offline within ~1–2 minutes if heartbeats stop; pin schedules must not assume registry alone.  
4. **GATEWAY_URL** for remotes: MBP Tailscale IP `http://100.112.77.123:8080` — fails when laptop gateway is down; control-plane HA is the real 24×7 fix, not moving agent brain to NAS.  
5. **Version drift**: keep remotes on same deploy stamp as intentional release; use `deploy-to-remote.sh … verify`.  
6. **oracle**: low-resource; prefer light/probe work; allow long startup grace after restart.

---

## 6. Same-day re-offline (2026-08-10 ~20:20–21:05 CST) `[E]`

After the morning redeploy recovery, `node34-executor-1` flipped registry-offline again
while the **process stayed healthy**.

### Evidence

| Surface | Observation |
| --- | --- |
| `systemctl` | `los-executor` active, `NRestarts=0`, `ActiveEnterTimestamp=15:33 CST` |
| Local `/health` | `status=ok`, `acceptingTasks=true`, version `0.1.0+b98714c660d7c` |
| Journal | `node heartbeat failed … timeout` then `heartbeat recovered after N consecutive failures` (20:42, 21:04) |
| Journal | continuous `file-sync-periodic` / PG `Connection terminated due to connection timeout` (~20:20–20:55) |
| Registry | reaper set offline when heartbeats missed; after hb returned, `status=online` but `candidate=false` |

### Root cause (this episode)

**Not process death.** Path instability **node34 → MBP control plane** over Tailscale:

1. Heartbeat POST to gateway timed out → stale-online reaper → registry offline.  
2. File-sync to Postgres `:55432` also timed out in the same window (same path family).  
3. When heartbeats resumed, verification stayed `heartbeat_claim_requires_active_probe` → **online but not candidate**.

### Recovery applied 21:11 CST

```bash
curl -X POST -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
  http://127.0.0.1:8080/nodes/node34-executor-1/probe
```

Result: `verified.agent_http(_ndjson).ok=true`, `execution.candidate=true`.

### Supervision gaps observed

- `dogfood runtime readiness` **succeeded** while listing `node34-executor-1` in `unavailableNodes` — reports, does not fail closed.  
- `/ops/runtime-health` only warns when **zero** candidates (`executors:no_candidate`); a single pinned node offline is silent if MBP remains candidate.  
- Log-freshness schedule is a weak signal (log mtime ≠ registry truth).  
- After auto-recover to online, **candidate still needs probe** (or a future auto-probe-on-online).

## 7. Follow-ups

| Item | Priority | Status |
| --- | --- | --- |
| Cleanup `test` / `test-heartbeat` / `node34-ssh` / vultr+tencent registry noise | low | **Done** 2026-08-10 — see `2026-08-10-vultr-tencent-dead-gateway-and-registry-cleanup.md` |
| Vultr / tencent-sin dead `GATEWAY_URL=100.75.41.120` analysis | medium | **Done** (config fixable; keep executor disabled) |
| Scheduled remote deploy when heartbeat auth contracts change | medium | open |
| node34 disk/container hygiene | medium | open |
| Control-plane anti-sleep / second gateway | only if 24×7 becomes a requirement | parked — MBP sleep is currently accepted; late readiness catch-up no longer advances fleet alerts |
| Rotate agent key if vultr unit bak exposed it | medium | open (operator decision) |
| dogfood/runtime-health: warn when fleet offline or online-unverified | medium | **Done** — `runtime-health` + readiness runner fleet filter |
| Auto-probe after heartbeat recovery when verified is heartbeat-only claim | medium | **Done** — gateway `node-auto-probe` (2/tick, 2s gap, 5m cooldown, 120s interval) |
| Heartbeat multi-node recovery stampede | low | **Done** — jitter ≤2s on heartbeat interval |
| File-sync list-refresh storm during PG path outage | medium | **Done** — exponential backoff to 15m + log throttle |
| oracle bind `EXECUTOR_HOST=0.0.0.0` | high | **Done** 2026-08-10 evening — candidate restored |
| desktop-r45553o Windows canary deploy | medium | **Done** 2026-08-10 evening — Task Scheduler `los-executor` |
| Named fleet inventory + consecutive-tick `ops.fleet_attention` | medium | **Done** — `fleet-inventory.ts` + readiness tick + WeChat/SSE |
| Resource thresholds from heartbeat capacity | medium | open — see monitoring plan P1 |
| NAS34 schedule: pin + non-sandbox network for TCP reachability self-check | medium | open (1 fail 2026-08-10) |

---

## 8. Related docs

- ADR 0010 node connectivity taxonomy  
- ADR 0011 node ops / artifact transfer  
- ADR 0012 service cluster roadmap  
- `docs/operations/2026-08-03-node-inventory.md`  
- `docs/operations/node-deployment-runbook.md`  
- `docs/operations/2026-08-10-executor-fleet-status-and-monitoring-plan.md` — **current fleet board + monitoring backlog**  
- `tools/deploy-to-remote.sh`
