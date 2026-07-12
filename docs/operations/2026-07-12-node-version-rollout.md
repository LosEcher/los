# Node Version Rollout

Date: 2026-07-12

## Scope

This rollout added immutable build identity to the gateway and executor
runtime, migrated the two active remote executors to managed systemd services,
and converged all active executor nodes on `0.1.0+bd17c4594f759`.

Offline registry records were not deployed. They must be updated and verified
before reactivation rather than being marked current from registry state alone.

## Final Node Evidence

| Node | Runtime | Version | Registry | Task load | Management |
| --- | --- | --- | --- | --- | --- |
| `mbp-executor-1` | healthy on `127.0.0.1:8090` [E] | `0.1.0+bd17c4594f759` [E] | online, fresh heartbeat [E] | `activeTaskCount=0` [E] | `tools/los.sh` / launchd [E] |
| `node34-executor-1` | healthy on `100.68.106.96:8090` [E] | `0.1.0+bd17c4594f759` [E] | online, fresh heartbeat [E] | `activeTaskCount=0` [E] | systemd, user `los`, `NRestarts=0` [E] |
| `oracle-executor` | healthy on port `8091` [E] | `0.1.0+bd17c4594f759` [E] | online, fresh heartbeat [E] | `activeTaskCount=0` [E] | systemd, user `los`, `NRestarts=0` [E] |

The registry reports `capabilities.run_agent=true` for all three nodes. Oracle
remains `heavy_task_safe=false`; its 954 MiB RAM profile is intentionally a
constrained executor. [E]

The abandoned Oracle executor process rooted at `npm exec tsx` under
`/home/ubuntu/los-executor` is absent after cutover. [E]

## Problems And Optimizations

1. Partial workspace synchronization failed frozen-lockfile validation and
   could leave stale runtime imports. Deployment now ships every `packages/`
   manifest and the executor runtime dependency closure. [E]
2. node34 initially started with stale `/opt/los/.env` database credentials.
   The known working node configuration was restored before version stamping;
   subsequent starts connected successfully. [E]
3. The first low-resource command used unsupported
   `--workspace-concurrency=1`. It was replaced with
   `--network-concurrency=1 --child-concurrency=1`. [E]
4. pnpm requested confirmation before replacing an incompatible
   `node_modules` tree and returned without a complete install in non-interactive
   SSH. Deployment installs now set `CI=true`. [E]
5. `--no-optional` removed esbuild's platform binary, so `tsx` could not start.
   Low-resource mode now keeps optional dependencies while retaining bounded
   concurrency and `NODE_OPTIONS=--max-old-space-size=128`. [E]
6. A single immediate health request produced false failures during database
   initialization. Verification now retries for up to 30 seconds. [E]
7. Verification assumed port 8090, while Oracle is configured for 8091. It now
   reads `EXECUTOR_PORT` from the remote `.env` when no explicit port is set.
   [E]
8. Oracle's old SSH-session process inherited a database URL that was absent
   from both on-disk `.env` files. Its host PostgreSQL listens on 5433, while
   port 5432 belongs to the vpsagent Docker database. Oracle now has an explicit
   LOS database URL and a matching local `los` role credential. [E]
9. Configured connection modes duplicated the executor defaults. The executor
   now deduplicates the merged modes; all three health responses report exactly
   `agent_http` and `agent_http_ndjson`. [E]
10. Health and heartbeat traffic generated missing actor-context warnings.
    Infrastructure paths now bypass that warning without weakening auth on
    operator routes. No matching warning appeared in the post-restart gateway
    log. [E]
11. JJ working-copy commit IDs changed whenever rollout documentation was
    updated, so they were not stable deployment identities. Versions now use a
    deterministic digest of deployable runtime content; documentation and
    generated output do not cause version churn. [E]
12. Package tests write runtime evidence under `packages/*/.los/streams`.
    Including those ignored files in the digest changed the candidate version
    after every full gate and copied test evidence to remote nodes. Versioning
    and deployment archives now exclude package-local `.los` directories. [E]
13. The deployment script assumed every target allowed Tailscale SSH as root,
    while node34 and Oracle use OpenSSH aliases with explicit identities and
    Oracle logs in as a sudo-capable non-root user. Deployment now supports an
    explicit OpenSSH target and optional sudo elevation without storing host
    credentials in the repository. [E]
14. OpenSSH joins remote command arguments into shell text, which initially
    broke `sh -c` boundaries and ran `pnpm install` from `/root`. Remote command
    arguments are now shell-escaped before transport; the failed attempt did
    not restart the serving node34 executor, whose health remained on the prior
    version until the corrected deployment completed. [E]

## Verification

- `pnpm run gate`: passed after the final code and deployment-script fixes (9
  phases, 13 test tasks, 0 failures, 237 seconds). [E]
- `pnpm check`: passed after the OpenSSH transport and command-escaping fixes.
  [E]
- `bash -n tools/deploy-to-remote.sh tools/los.sh tools/setup-node.sh`: passed.
  [E]
- `./tools/check-contracts.sh`: passed for 15 contracts. [E]
- OpenSSH alias probes succeeded for node34 as root and Oracle with sudo
  elevation before rollout. [E]
- Local and remote `/health`, systemd state, and authenticated `GET /nodes`
  were checked after the final rollout. [E]

## Follow-Up

- Offline eval, desktop, Tencent, Vultr, retired SSH, and test fixture registry
  records remain unstamped. Update each only when it is reactivated and a live
  health plus heartbeat can be verified. [E]
- A deployment preflight should eventually validate required `.env` keys and
  distinguish local PostgreSQL, Docker-published PostgreSQL, and inherited
  process environment before service cutover. [I]
- The systemd unit still launches TypeScript through `tsx`. A production build
  artifact would reduce startup time and remove the runtime esbuild dependency,
  but package conditional exports must be completed first. [I]
