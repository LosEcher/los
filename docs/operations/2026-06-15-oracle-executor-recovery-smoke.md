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

- oracle-executor **not present** in gateway `/nodes` response
- The executor responds to `/health` but its heartbeat is not reaching the gateway
- Likely causes: `GATEWAY_URL` missing or wrong in Oracle `.env`, or gateway cannot route to Oracle's executor port
- **This is a blocker** — the node is healthy locally but invisible to the scheduler

## 5. `pnpm --filter @los/executor check`

Not checked. `pnpm` is not in path for the `los` user on Oracle; the executor runs via systemd using a hardcoded node command.

## 6. Residual risks

| Risk | Detail |
| --- | --- |
| Low memory | 1GB RAM with no swap → OOM risk under task load |
| No DB registration | Gateway cannot schedule tasks to this node |
| pnpm path dependency | systemd unit uses `tsx@*/node_modules/tsx/dist/cli.mjs` — brittle to pnpm lock changes |
| Stopped non-LOS containers | 1Panel-managed containers stopped during recovery; not restarted |
| No executor build artifact | Runs source via tsx, not compiled dist |

## 7. Next actions

1. Fix `GATEWAY_URL` in Oracle `.env` so heartbeat reaches gateway
2. Verify `oracle-executor` appears in gateway `/nodes` with `status=online`
3. Dispatch a dry-run task to `oracle-executor` and verify `task_runs.node_id` matches
4. Add swap (2GB+) to reduce OOM risk
5. Replace tsx dev launch with built artifact (`packages/executor/dist/index.js`)
