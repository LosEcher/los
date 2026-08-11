# Vultr / Tencent-sin dead gateway analysis + registry cleanup — 2026-08-10

> Companion to `2026-08-10-control-plane-vs-executor-and-node-recovery.md`.  
> Evidence: live SSH on `vultr-r-t` / `tencent-sin-t`, Tailscale, registry DB.

## 1. Registry cleanup applied `[E]`

### Deleted `executor_nodes`

| node_id | Why deleted |
| --- | --- |
| `test` | Fixture row, no task_runs refs |
| `test-heartbeat` | Fixture (`http://test:8090`) |
| `node34-ssh` | Duplicate identity of `node34-executor-1` (stale agent_http row) |
| `vultr-executor` | Intentionally not an executor; misleading offline noise in readiness |
| `tencent-sin-executor` | Same |

### Deleted `service_instances`

- 23× stale `eval-e02-*` offline gateway fixtures + old local gateway ports  
- Kept: `gateway-echers-mbp-local-8080` (online) and two old local gateway rows offline (8081/18080) if still present after filter

### Remaining registry (target shape)

| node_id | status | kind | Role |
| --- | --- | --- | --- |
| mbp-executor-1 | online | executor | Primary |
| node34-executor-1 | online | executor | Linux / NAS-adjacent |
| oracle-executor | online | executor | Low-resource optional |
| desktop-r45553o | offline | executor | Optional Windows host |
| localnode34 | offline | ssh_target | LAN VM metadata |
| oracle-t | offline | ssh_target | SSH alias metadata |

No FK blocked deletes (`executor_nodes` has no inbound FKs; 0 task_runs on deleted ids).

---

## 2. Vultr — crash-loop / dead gateway root cause

### Facts `[E]` (SSH `vultr-r-t`, 100.93.104.96:23452)

| Item | Value |
| --- | --- |
| Host role today | **Mesh / exit node / DERP / 1Panel / sing-box / cloudflared** — not coding executor |
| RAM | **955 MiB** (+2.3 GiB swap) — marginal for los agent loop |
| `/opt/los` | Present (tree ~ Jun 14–16) |
| `los-executor` unit | **disabled**, **inactive** (no journal — stopped long ago) |
| Historical `GATEWAY_URL` | `http://100.75.41.120:8080` |
| Dead IP | `100.75.41.120` — **not in current Tailnet**, ping 100% loss |
| Unit file issue | Hard-coded `Environment=GATEWAY_URL=…` + **inline `EXECUTOR_AGENT_KEY`** (secret in unit) |
| `Restart=always` + `RestartSec=5` | Would spin forever when gateway unreachable |

### Causal chain

```text
Gateway moved / Tailscale IP retired (100.75.41.120 gone)
  → executor heartbeat/register always fail
  → systemd Restart=always every 5s
  → crash-loop (tens of thousands of restarts historically)
  → operator disabled unit (correct)
```

This is **config drift**, not a hardware failure. Matching 2026-08-03 inventory notes.

### Can it be “fixed” as an executor?

| Fix | Effort | Recommend? |
| --- | --- | --- |
| Point `GATEWAY_URL` → current MBP TS IP (`http://100.112.77.123:8080`) | trivial | Hygiene only (done) |
| Redeploy current code + enable service | medium | **No by default** |
| Use as always-on light executor | high risk | RAM 1G; competes with derper/cloudflared/sing-box |

**Verdict:** Root cause is **understood and remediable** (update gateway URL + key + modern heartbeat code). **Do not re-enable** as production executor unless role-role the host away from DERP/mesh or add RAM. Prefer node34/oracle for remote compute.

### Hygiene applied on vultr `[E]`

- `.env`: `GATEWAY_URL=http://100.112.77.123:8080`, `EXECUTOR_ENABLED=false`  
- unit: `EnvironmentFile=/opt/los/.env`, no inline secret; unit **disabled**  
- backups: `/opt/los/.env.bak.20260810`, unit `.bak.20260810`

---

## 3. Tencent-sin — dead gateway + role conflict

### Facts `[E]` (SSH `tencent-sin-t`, 100.93.220.9:23452)

| Item | Value |
| --- | --- |
| Host role today | **vpsagent control-plane** (docker: lb, redis, postgres), cloudflared×2, 1panel, nginx, sing-box mesh |
| RAM | 3.6 GiB (better than vultr) |
| Disk | ~73% of 60G |
| `/opt/los` | Thin tree (packages Jun 12–17); incomplete vs full monorepo deploy |
| Unit | **disabled / inactive** |
| Same dead `GATEWAY_URL` | `http://100.75.41.120:8080` |
| Registry `base_url` was | `http://127.0.0.1:8090` — **not mesh-reachable** even if process ran |

### Causal chain

Same dead gateway IP → heartbeat failure → Restart=always → historical loop → disabled.

Additional issues if re-enabled:

1. Incomplete `/opt/los` (not a current deploy stamp)  
2. `base_url` loopback useless to MBP gateway  
3. Role collision with long-running vpsagent stack  
4. Disk pressure  

### Verdict

**Fixable as config**, **not recommended as executor**. Keep as mesh/control-plane backup host. Hygiene applied same as vultr (GATEWAY_URL updated, EXECUTOR_ENABLED=false, unit disabled, EnvironmentFile).

---

## 4. If someone insists on re-enabling later

Checklist (either host):

1. Confirm role: executor vs mesh/control-plane (prefer **not** dual-purpose on 1G).  
2. `deploy-to-remote.sh <node> full-setup` with current stamp + correct `LOS_SSH_*`.  
3. `.env`: `GATEWAY_URL=http://100.112.77.123:8080` (or future HA gateway), shared `EXECUTOR_AGENT_KEY`, public `EXECUTOR` URL on Tailscale.  
4. Unit: **only** `EnvironmentFile`, no secrets in unit drop-ins.  
5. `systemctl enable --now` only after `curl $GATEWAY_URL/health` succeeds from the host.  
6. Re-register appears automatically via heartbeat; verify `executor_nodes.status=online`.  
7. Do **not** use local `postgres://127.0.0.1` as los control DB for remote executors that must share the MBP mesh DB (or intentionally run isolated — then they are not mesh workers).

---

## 5. Summary table

| Host | Dead gateway? | Crash-loop root | Fixable? | Should run executor? | Action taken |
| --- | --- | --- | --- | --- | --- |
| vultr | Yes `100.75.41.120` | Restart=always + dead GW + low RAM | Yes | **No** (DERP/mesh) | URL fixed; unit disabled; registry row removed |
| tencent-sin | Yes same IP | Same + incomplete deploy + role conflict | Yes | **No** (vpsagent CP) | Same |
| node34 / oracle | N/A (alive) | Old code missing Bearer (fixed earlier) | Done | Yes | Online |
| test* / node34-ssh | N/A | Noise | N/A | N/A | Deleted |

---

## 6. Residual risk

- MBP Tailscale IP change would again break remotes’ `GATEWAY_URL` — prefer stable MagicDNS name when available.  
- vultr unit historically leaked agent key in unit file (bak kept); rotate key if that host is untrusted.  
- desktop-r45553o still offline optional; localnode34 LAN VM still parked.  
