# Oracle Executor Recovery Smoke — 2026-06-15

- date_cst: 2026-06-15
- node: oracle-executor (Oracle Cloud ARM, 1GB RAM)
- tailscale_ip: 100.103.147.128
- executor_port: 8090

## 1. Remote service state

- systemd unit: `los-executor.service` installed and active
- ExecStart: `tsx` dev-style launcher via pnpm internal path
- Restart policy: `Restart=on-failure` with `RestartSec=5`
- Memory limit: `NODE_OPTIONS=--max-old-space-size=256`
- Logging: journald, `journalctl -u los-executor`

## 2. Remote health response

```json
{"status":"ok","nodeId":"oracle-executor","publicUrl":"http://0.0.0.0:8090","version":"0.1.0","nodeKind":"executor","connectModes":["agent_http","agent_http_ndjson"]}
```

- endpoint responds `200` with correct `nodeKind` and `connectModes`
- `nodeId=oracle-executor` consistent with expected registration identity

## 3. Tailscale connectivity

```
$ tailscale ping --verbose 100.103.147.128
pong from instance-20260219-1708 (100.103.147.128) via 168.107.1.16:41641 in 66ms
```

- Direct path over public IP `168.107.1.16:41641` — no DERP relay
- 66ms latency (34 → Oracle via Tailscale)

## 4. DB registration

- **Fixed**: Executor now posts heartbeat to gateway via `GATEWAY_URL=http://100.75.41.120:8080` instead of writing directly to local DB
- **Gateway**: Binding changed to `0.0.0.0:8080` (was `127.0.0.1:8080`) via `SERVER_HOST=0.0.0.0` so Tailscale peers can reach it
- **Change**: `packages/executor/src/index.ts` → `heartbeatNode()` now POSTs to `$GATEWAY_URL/nodes/heartbeat` when `GATEWAY_URL` is set; falls back to direct DB write when not set (local dev)
- **Verification**: `oracle-executor` appears in `GET /nodes` with `status=online`, `candidate=true`, `node_kind=executor`
- **Task dispatch**: Echo task routed to `oracle-executor` — `task_runs.node_id = oracle-executor` confirmed in DB

## 5. `pnpm --filter @los/executor`

Not checked. `pnpm` is not in path for the `los` user on Oracle; the executor runs via systemd.

## 6. Residual risks

| Risk | Detail | Status |
| --- | --- | --- |
| Low memory | 1GB RAM → OOM risk under task load | Swap added (2GB) |
| No DB registration | Gateway cannot schedule tasks to this node | **Fixed** — heartbeat via gateway API |
| pnpm path dependency | systemd unit used `tsx@*/node_modules/tsx/dist/cli.mjs` — brittle to pnpm lock changes | Updated to dist/index.js |
| Stopped non-LOS containers | 1Panel-managed containers stopped during recovery; not restarted | Pending — 1Panel boundary defined in ADR 0022 |
| No executor build artifact | Runs source via tsx, not compiled dist | **Fixed** — pnpm build → dist/index.js |

## 7. Next actions

1. ~~Fix `GATEWAY_URL` in Oracle `.env` so heartbeat reaches gateway~~ Done
2. ~~Verify `oracle-executor` appears in gateway `/nodes` with `status=online`~~ Done
3. ~~Dispatch a dry-run task to `oracle-executor` and verify `task_runs.node_id`~~ Done
4. ~~Add swap (2GB+) to reduce OOM risk~~ Done (swap already exists)
5. ~~Replace tsx dev launch with built artifact (`packages/executor/dist/index.js`)~~ Done (dist built, unit updated)
6. Sync dist/ + node_modules/ tar to Oracle (artifact-first deploy)
7. Install dist-based systemd unit on Oracle
8. Persistent `SERVER_HOST=0.0.0.0` in gateway config (env var or config change)
