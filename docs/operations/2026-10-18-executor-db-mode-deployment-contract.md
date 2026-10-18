---
subject: executor DB-mode deployment contract (.env.example / runbook / deploy-to-remote.sh)
auditedRev: 403fe4cd (los git HEAD at batch start, 2026-10-18)
readOnly: false
method:
  - live node34 /health and /opt/los/.env mode keys
  - source reading (executor dbMode assertions, event spool, node credential, artifact root)
  - deploy-to-remote.sh local negative controls (fabricated env/health snapshots)
---

# Executor DB-mode deployment contract

Date: 2026-10-18
Batch: A (config surfaces for `EXECUTOR_DB_MODE`, `GATEWAY_URL`,
`EXECUTOR_TASK_TOKEN_MODE`, local spool/credential/artifact ownership)

## 1. Acceptance criteria (written before implementation)

The batch is accepted only when **all** of the following hold. Each criterion
names the surface that proves it; a prose claim is not evidence.

### A1 — `.env.example` states the mode contract

- `EXECUTOR_DB_MODE` is documented with exactly `required | none`, its
  bootstrap consequences (`initDb` / migrations / agent stores / file-sync), and
  the explicit rule that **having `DATABASE_URL` is not a mode** and there is
  **no runtime auto-fallback**.
- `none` is documented as a **canary**, not the fleet default, with the
  fail-closed rollback (`/opt/los/.env.p3-backup` + restart `los-executor`).
- `GATEWAY_URL` is marked required when `EXECUTOR_DB_MODE=none` or
  `EXECUTOR_TASK_TOKEN_MODE=required`.
- `EXECUTOR_TASK_TOKEN_MODE` states the 401/403/409 abort semantics.
- Local state ownership is explicit: event spool
  `.los-runtime/executor-events/<nodeId>/`, artifact CAS
  `.los-runtime/executor-artifacts/<nodeId>/`, node credential state
  `.los-runtime/executor/node-credential-<nodeId>.json` (file 0600; parent dir
  created 0700 — refined after live evidence, see §4),
  all owned by the **executor service user**, not the gateway, and excluded
  from the deployed content digest.

**Proof**: `read .env.example`; a grep for the four names returns a documented
line, and no line describes `DATABASE_URL` as universally required.

### A2 — Runbook is mode-aware and cannot mislead a no-DB node

- Preflight lists the required env keys **per mode**, instead of requiring
  `DATABASE_URL` unconditionally.
- The DB-listener check is conditional on `EXECUTOR_DB_MODE=required`.
- Cutover verification includes mode evidence: `/health.db`,
  `/health.taskTokenMode`, `/health.leaseTransport`, plus gateway reachability,
  event/spool backlog, and "no executor DB connection" for `none`.
- Rollback covers a no-DB node: restore `/opt/los/.env.p3-backup`, remove
  `DATABASE_URL`-less mode keys as needed, restart, and re-check mode evidence.
- A stateless-node section names the local state directories and their owner/
  mode, and states that a gateway restart during a task is **fail-closed**
  (task reaped/converged failed), not silently resumed.

**Proof**: `read docs/operations/node-deployment-runbook.md`; no sentence says
every executor must have `DATABASE_URL`.

### A3 — `deploy-to-remote.sh` enforces the contract fail-closed

- New read-only command `deploy-to-remote.sh <node> mode` prints
  `db/taskToken/gateway/database` presence and validates the **remote** `.env`
  plus `/health`, exiting non-zero on any violation.
- `preflight` runs the same env validation and **blocks** on a violation.
- `verify` runs env + health validation and **dies** before reporting success
  on a violation.
- For `EXECUTOR_DB_MODE=none` the validator fails when **any** of these is
  true: `DATABASE_URL` is set; `GATEWAY_URL` is unset;
  `EXECUTOR_TASK_TOKEN_MODE != required`; `health.db != none`;
  `health.leaseTransport != http-when-token`.
- For `EXECUTOR_DB_MODE=required` the validator fails when `DATABASE_URL` is
  unset or `health.db != postgres`.
- An undeclared mode is treated as **legacy** and warns (it does not invent a
  mode), but it must still have `DATABASE_URL`; otherwise it fails. An invalid
  value fails. Env parsing mirrors `loadEnvFile` (trim, matching quotes, last
  assignment wins), so the validator cannot disagree with the process about
  what a line means.
- Local negative controls are runnable without a node:
  `deploy-to-remote.sh mode-check <env-file> [health-json]`.
- Existing DB-mode nodes keep their behaviour (missing `GATEWAY_URL` remains a
  warning for legacy/`required`, not a new hard failure).

**Proof**: `bash -n`; the `mode-check` negative-control matrix below; live
`mode` on node34.

### A4 — Live evidence on the canary

- `deploy-to-remote.sh <node34> mode` exits 0 and reports `db=none`,
  `taskToken=required`, `gateway=set`, `database=unset`, with
  `health.db=none`, `health.leaseTransport=http-when-token`,
  `eventBacklog=0`, `spoolBacklog=0`.
- `preflight` on node34 passes the mode gate (resource gate may be reported
  separately).

**Proof**: exact command + output recorded in §4.

### A5 — Negative controls (must fail, not warn)

| Fixture | Expected |
| --- | --- |
| `none` + `DATABASE_URL` set | exit 1, `DATABASE_URL` violation |
| `none` + no `GATEWAY_URL` | exit 1, `GATEWAY_URL` violation |
| `none` + `EXECUTOR_TASK_TOKEN_MODE=auto` | exit 1, token-mode violation |
| `required` + no `DATABASE_URL` | exit 1, `DATABASE_URL` violation |
| `none` + health `db=postgres` | exit 1 |
| `none` + health `leaseTransport=db` | exit 1 |
| `none` valid env + health | exit 0 |
| `/health` unreachable | exit 1 (never "assume good") |

**Proof**: scripted loop, output recorded in §4.

### A6 — Repository gates and delivery

- `bash -n tools/deploy-to-remote.sh`, `pnpm check:doc-anchors`,
  `pnpm check:workspace-docs` pass.
- This document is registered in `docs/README.md` (Operation Smokes).
- One intent, Forgejo PR, exact-head checks, merge without `force_merge`;
  GitHub mirror is **not** touched by this batch.

## 2. What changes

| Surface | Change |
| --- | --- |
| `.env.example` | `EXECUTOR_DB_MODE` (`required`/`none`, no auto-fallback, canary status, fail-closed rollback), `GATEWAY_URL` requirement, token-mode failure semantics, artifact root, node credential keys, and the local-state ownership table (event spool, artifact CAS, credential file). `DATABASE_URL` is now scoped to the control plane / `required` executors. |
| `tools/deploy-to-remote.sh` | One `validate_mode_env` used by `preflight` (env only), `verify` (env + `/health`), the new read-only `<node> mode`, and the local `mode-check` fixture command. `none` + any violation fails; `required` without `DATABASE_URL` fails; an undeclared mode stays legacy with a warning but must still have `DATABASE_URL`. Env parsing mirrors `loadEnvFile`. `verify` also stops treating a missing `GATEWAY_URL` as "direct-to-DB mode" on a `none` node, and refuses an unreachable gateway for `none`. |
| `docs/operations/node-deployment-runbook.md` | New "Executor DB Modes" section, mode-aware preflight, mode evidence in cutover verification, local-state ownership, and a no-DB rollback procedure. |
| `docs/README.md` | Operation-smoke index entry for this document. |

No scheduling, placement, provider, storage-retention, or executor-runtime
change is included. The executor code already enforced
`dbMode=none ⇒ GATEWAY_URL + taskTokenMode=required` at startup; this batch
aligns the **deployment** surfaces with that contract and makes a mismatch
fail before a restart instead of after one.

## 3. What this batch deliberately does not do

- It does not promote `EXECUTOR_DB_MODE=none` to the remote default.
- It does not prove gateway restart survival; P4 remains **fail-closed**.
- It does not change scheduling, placement, provider routing, or storage
  retention.
- It does not roll fleet content: the deploy script's own digest changes, so
  `verify` on an unrolled node is expected to fail the version assertion until
  the next deliberate rollout.

## 4. Live and negative-control evidence

All commands ran on 2026-10-18 from the gateway host; `node34` was reached via
the OpenSSH alias `localnode34-r-t`. `[E]` = exact output below.

### 4.1 Node34 mode surface `[E]`

```text
$ ssh localnode34-r-t 'grep -E "^(EXECUTOR_DB_MODE|EXECUTOR_TASK_TOKEN_MODE|GATEWAY_URL)=" /opt/los/.env; grep -c "^DATABASE_URL=" /opt/los/.env'
GATEWAY_URL=http://100.112.77.123:8080
EXECUTOR_TASK_TOKEN_MODE=required
EXECUTOR_DB_MODE=none
0
```

```json
{"status":"ok","nodeId":"node34-executor-1","version":"0.1.0+bc63799a80f0c",
 "taskTokenMode":"required","db":"none","eventBacklog":0,"spoolBacklog":0,
 "leaseTransport":"http-when-token","lifecycle":"online","activeTaskCount":0}
```

`ss -tnp | grep -E ':(55432|5432)\b'` on the node returned `none`; the executor
has no database connection.

Local state on the node (`los:los`):

```text
drwxr-xr-x  /opt/los/.los-runtime/executor
drwxr-xr-x  /opt/los/.los-runtime/executor-artifacts
drwxr-xr-x  /opt/los/.los-runtime/executor-events
-rw-------  /opt/los/.los-runtime/executor/node-credential-node34-executor-1.json
```

The credential **file** is `0600`. The parent directory is `0755`, not `0700`:
the code creates it with `0700` but does not tighten an already-existing
directory. The docs were corrected to say "created 0700" rather than claiming
the live directory is `0700` (see §5, finding F2).

### 4.2 Deployment commands `[E]`

```text
$ LOS_SSH_TRANSPORT=ssh LOS_SSH_TARGET=localnode34-r-t \
    ./tools/deploy-to-remote.sh node34 mode
mode: db=none taskToken=required gateway=set database=unset
mode-check: ok
[deploy:node34] mode contract: OK
```

```text
$ LOS_SSH_TRANSPORT=ssh LOS_SSH_TARGET=localnode34-r-t \
    ./tools/deploy-to-remote.sh node34 preflight
mode: db=none taskToken=required gateway=set database=unset
mode-check: ok
[deploy:node34] preflight passed
```

`verify` was run with `LOS_DEPLOY_VERSION=0.1.0+bc63799a80f0c` (the node's
recorded build) and `LOS_DEPLOY_AUTO_PROMOTE=0`, because this batch edits
`tools/deploy-to-remote.sh`, which is covered by the deployable-content digest:
an unrolled node is *expected* to fail the version assertion until the next
deliberate rollout. The mode gate itself is the same code path:

```text
systemd: active
health: ok
version: 0.1.0+bc63799a80f0c
mode: db=none taskToken=required gateway=set database=unset
mode-check: ok
gateway http://100.112.77.123:8080: reachable
stateless node: no executor DB writes; check the registry from the gateway
unirun: ok (0.5.0)
verify complete
```

### 4.3 Negative controls `[E]`

`deploy-to-remote.sh mode-check <env> <health>` is the same validator with no
SSH. Fixtures are quoted by their content; `RC` is the exit code.

| Env / health | Observed | RC |
| --- | --- | --- |
| `none`, token `required`, gateway set, no DB / `db=none`, `http-when-token`, 0/0 | `mode-check: ok` | 0 |
| same env, no health file | `mode-check: ok` (preflight path) | 0 |
| `none` + `DATABASE_URL` set | `EXECUTOR_DB_MODE=none but DATABASE_URL is set` | 1 |
| `none` + no `GATEWAY_URL` | two FAILs (gateway required by mode and by token mode) | 1 |
| `none` + token `auto` | `requires EXECUTOR_TASK_TOKEN_MODE=required` | 1 |
| `required` + no `DATABASE_URL` | `EXECUTOR_DB_MODE=required but DATABASE_URL is unset` | 1 |
| `none` env + health `db=postgres` | `health.db='postgres' but EXECUTOR_DB_MODE=none` | 1 |
| `none` env + health `leaseTransport=db` | `expected http-when-token` | 1 |
| `none` env + empty health file | `health snapshot is empty` | 1 |
| node `.env` absent (`__ENV_MISSING__`) | `the node has no .env at the configured path` | 1 |
| undeclared mode + no `DATABASE_URL` | legacy WARN plus `DATABASE_URL is unset` FAIL | 1 |
| leading spaces / quoted values / empty then set `DATABASE_URL` | last assignment wins; reports `database=set` and fails | 1 |
| `required` + DB, health `db=postgres` | `mode-check: ok` | 0 |

### 4.4 Repository gates `[E]`

```text
bash -n tools/deploy-to-remote.sh                         -> 0
pnpm check:doc-anchors                                    -> OK (baseline debt 28, stale 0)
pnpm check:workspace-docs                                 -> OK (12 docs scanned)
pnpm check:deployable-content                             -> 8/8 pass
./tools/check-structure.sh                                -> 0 (49 warnings, none new)
```

## 5. Adversarial review

### What is proven

- The deployment surfaces now agree with the executor's existing startup
  contract, and a `none` node that still holds a DB URL cannot pass preflight,
  verify, or `mode` (negative controls and live node34).
- node34 is live on `db=none` with `eventBacklog=0`, `spoolBacklog=0`, and no
  database connection, and the new `mode` command reports OK against the
  **remote** `.env` + `/health`, not a local copy.
- The rule has one implementation (`validate_mode_env`); a second script cannot
  drift from it without being noticed.

### Findings (kept because they falsified something we wrote)

**F1 — the first snapshot encoding produced a false red.** The initial
`read_remote_mode_env` emitted `DATABASE_URL=set|unset`, and the validator read
the snapshot with the same `env_value` used for real `.env` files. It therefore
treated the literal string `unset` as a non-empty credential and failed node34
with `DATABASE_URL is set` even though the node has no such line. The live run
caught it; the snapshot now emits `<redacted>` for presence and an empty value
for absence. Lesson: a presence sentinel must not share the value's namespace.

**F2 — `0700` was a claim, not a live fact.** The credential file is `0600`,
but its parent dir on node34 is `0755`. `mkdirSync(..., { mode: 0o700 })` does
not chmod an existing directory. Docs now say "created 0700"; this is a
residual risk (the filename exposes only the node id, the credential itself is
`0600`), and the code-level follow-up is to `chmod` the directory on startup
(or in `saveNodeCredential`). It is not fixed here because this batch does not
roll executor content; shipping a fix without rolling it would make the docs
true for new nodes and still false for the canary.

**F3 — verify without a rollout is impossible by design.** The deploy script is
covered content, so editing it moves the target digest. The live verify above
used `LOS_DEPLOY_VERSION` as an explicit, recorded reproduction override, with
auto-promote disabled. Do not copy that command into a rollout script: a normal
rollout must sync first.

### Residual risks and what this does not prove

1. **Legacy declarations are still a hole.** An undeclared `EXECUTOR_DB_MODE`
   with a `DATABASE_URL` keeps the old DB path and passes with a `WARN`. A node
   that *should* be `none` but never declares it is not detected. Migration
   item: declare the mode on every node before treating the fleet as
   contract-conformant. (Undeclared **and** no `DATABASE_URL` does fail.)
2. **Backlog is a warning by default.** A `none` node with a non-zero
   `eventBacklog`/`spoolBacklog` still verifies (events are spooled, not
   necessarily lost). Use `LOS_DEPLOY_REQUIRE_ZERO_BACKLOG=1` when zero backlog
   is the rollout acceptance condition.
3. **The gateway reachability check is from the deploy host, not the node.**
   The pre-existing check curls `GATEWAY_URL/health` from the operator machine.
   A node behind a different route could pass locally while its own egress is
   broken. The node's heartbeat freshness in the registry remains the required
   second source.
4. **Windows nodes are not covered** by `deploy-to-remote.sh`; their driver
   path does not run this validator. No claim is made about Windows DB mode.
5. **P4 semantics are unchanged.** This batch does not promote `none` to the
   default, does not prove task survival across a gateway restart, and does not
   change the fail-closed close decision. It only makes the existing contract
   checkable before a restart.
6. **GitHub mirror untouched.** Forgejo is the only remote used by this batch.
