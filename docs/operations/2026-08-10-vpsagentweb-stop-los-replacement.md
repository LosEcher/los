# Stop vpsagentweb; los is the execution plane — 2026-08-10

> Action: **stop/disable** (data directories and unit files retained for rollback).  
> Replacement: **los** control plane on MBP + executors mbp / node34 / oracle.

## Goal

Operator instruction: 停掉 vpsagentweb，用 los 替代.

## What was running (before)

| Host | vpsagent surface |
| --- | --- |
| tencent-sin | `vpsagent`, `vpsagent-api-tencent-sin`, `cloudflared-vpsagent-control`, nightly/probe timers, docker `vpsagent-control-plane-lb` + `deploy-redis` + `deploy-postgres` |
| oracle | `vpsagent`, `vpsagent-api-oracle`, `cloudflared-vpsagent-control`, timers |
| node34 | `vps-agent.service` failed/enabled leftover + `/home/z/vpsagent*` trees |
| vultr | already clean of vpsagent |
| MBP | source archive only; no running process |

## Actions taken `[E]`

### tencent-sin (`tencent-sin-t`)

1. `systemctl disable --now` timers: `vpsagent-nightly-acceptance.timer`, `control-plane-probe.timer`  
2. `systemctl disable --now`: `vpsagent`, `vpsagent-api-tencent-sin`, `cloudflared-vpsagent-control`  
3. `docker stop` (volumes **not** removed): `vpsagent-control-plane-lb`, `deploy-redis-1`, `deploy-postgres-1`  
4. Kill leftover tmux session `vpsagent`  
5. Log: `/var/log/vpsagentweb-stop-20260810.log`

Post-check: no vpsagent processes; units disabled; docker containers **Exited**; no :28084 listen.

### oracle (`oracle-t`)

1. Same timer disable  
2. `disable --now`: `vpsagent`, `vpsagent-api-oracle`, `cloudflared-vpsagent-control`  
3. Confirmed **`los-executor` stayed active** and `/health` ok on :8091  
4. No :28080 listen after stop  

### node34 (`localnode34-r-t`)

1. `systemctl disable --now vps-agent.service` (was failed since ~2026-07-24)  
2. **`los-executor` remains active** :8090  
3. Disk trees `/home/z/vpsagent*` **kept** (not deleted)

## los replacement surface (current)

| Role | Where |
| --- | --- |
| Gateway / scheduler / WeChat | MBP `gateway` :8080 |
| Primary executor | `mbp-executor-1` |
| Remote Linux executor | `node34-executor-1` (`linux-bwrap`) |
| Low-resource remote | `oracle-executor` (:8091) |

Registry online (post-stop): all three executors online, version `0.1.0+b98714c660d7c`.

## Not deleted (on purpose)

- `/opt/vpsagent-*` binaries and configs (rollback)  
- Docker volumes for deploy-postgres/redis (data retain)  
- Local workspace mirrors: `los-workspace/projects/vpsagentweb`, `~/Downloads/projects/vpsagentweb` (legacy reference only)  
- `lot2extension-runner` exited container on node34 (Forgejo runner, not vpsagent control plane)

## Rollback (if needed)

```bash
# example oracle
sudo systemctl enable --now vpsagent-api-oracle vpsagent cloudflared-vpsagent-control
# tencent-sin: also docker start deploy-postgres-1 deploy-redis-1 vpsagent-control-plane-lb
```

Only after confirming no port clash with los and intentional dual-stack ops.

## Residual / follow-up

| Item | Notes |
| --- | --- |
| Disk cleanup of `/opt/vpsagent-*` | Optional later after observation window |
| Public cloudflared DNS still pointing at stopped control plane | Expect external vpsagent URLs to fail — update or retire DNS |
| Nightly acceptance | Disabled; no further auto probes |
| Agent key in old unit backups | Unrelated rotation still recommended if vultr bak was exposed |

## Related

- `2026-08-10-control-plane-vs-executor-and-node-recovery.md`  
- `2026-08-10-vultr-tencent-dead-gateway-and-registry-cleanup.md`  
