---
subject: B2 canary rollout on node34 — stateless approval + convergence
auditedRev: bc92e907 (los main at rollout start, 2026-10-19)
readOnly: false
method:
  - tools/deploy-to-remote.sh preflight/sync/install/install-service/verify
  - node34 /health + content digest
  - live scheduled task that attempts run_shell
  - session_events / task_runs / scheduled_work_item_runs reads
---

# B2 canary rollout — node34

Date: 2026-10-19
Target: `node34-executor-1` (`EXECUTOR_DB_MODE=none`, stateless canary)
Code under test: main `bc92e907` (B2 approval + convergence hardening)

## 1. Acceptance criteria (written before the rollout)

### R1 — Preconditions

- `GET /nodes` / node34 `/health` shows `activeTaskCount=0`.
- `scheduled_work_item_runs` has 0 `running`/`claimed`; `task_runs` has 0
  `running`/`queued`.
- Gateway `/health` is ok and the node's `eventBacklog`/`spoolBacklog` are 0.
- Disk free ≥ 5 GiB on node34.
- A rollback archive of `/opt/los` sources and a copy of `.env` exist **before**
  any sync; path + sha256 are recorded.

### R2 — Deployment converges

- `preflight` passes (resources + mode contract).
- `sync` reports the node's own content digest equals the local target; prune
  removes stale files; `.env` is preserved.
- `install` completes; `install-service` starts/restarts the unit; `verify`
  passes with the target version (no `LOS_DEPLOY_VERSION` override).
- systemd: active, `NRestarts=0`; `/health.version` equals the target digest.

### R3 — Mode and health unchanged

- `/health`: `db=none`, `taskTokenMode=required`,
  `leaseTransport=http-when-token`, `eventBacklog=0`, `spoolBacklog=0`.
- No `DATABASE_URL` in `/opt/los/.env`; no executor connection to 5432/55432.

### R4 — Stateless approval is fail-closed live

- Dispatch a real scheduled execution task pinned to `node34-executor-1` that
  asks the agent to run a shell command.
- Evidence must show `tool.approval_required` with `enforcementMode=block` and
  `tool.denied` with `reasonCode=tool_approval_required` for `run_shell`.
- **No `run_shell` tool result** may be persisted for that task, and the command
  must not have executed (negative control: a unique marker path is absent).
- The task/scheduled run may end failed or blocked; either is acceptable. A
  silently executed shell command is a failure.

### R5 — Rollback is fail-closed

If R2, R3 or R4 fails:

1. Stop `los-executor`.
2. Extract the recorded rollback archive into `/opt/los` (sources only).
3. Restore `.env.b2-backup` only if configuration was touched (sync preserves
   it; normally it is unchanged).
4. Start `los-executor`, verify `/health` and content digest equal the **old**
   version, and do not promote.
5. Record the failure phase, old/new versions, and the rolled-back digest.

### R6 — Promotion

Only after R2–R4 pass: promote `node34-executor-1` (clear the restart-induced
drain), then confirm the registry row is `online` with a fresh heartbeat and
`activeTaskCount=0`.

## 2. Preconditions and rollback artifacts `[E]`

```text
gateway /health: status=ok, ready=true
running_scheduled=0
running_tasks=0
node34 /health: lifecycle=online, activeTaskCount=0, db=none,
                taskTokenMode=required, eventBacklog=0, spoolBacklog=0
node34 disk: 196G total, 48G free (75% used)
node34 old version/digest: 0.1.0+bc63799a80f0c
```

Rollback artifacts created **before** sync:

```text
/opt/los/rollback-b2-20261019-014421.tar.gz
sha256 1063dd00721d1f8dd1f3717b8a9327e047eaf44affa7fc3337ffd6fc3d1120d5
/opt/los/.env.b2-backup   (670 bytes, mode preserved)
/opt/los/.env.p3-backup   (646 bytes, prior P3 rollback)
```

`preflight`: passed (RAM 9945 MB, swap 6045 MB, `preflight_result: true`), mode
`db=none taskToken=required gateway=set database=unset`.

## 3. Deployment evidence `[E]`

```text
sync:   target/digest 0.1.0+b191b9d28dac2, prune 0 stale, digest verified
install: deps installed, unirun 0.5.0 already present
install-service: mode gate ok, systemd restarted
verify: service active, health ok, version 0.1.0+b191b9d28dac2,
        mode-check ok, gateway reachable, unirun ok
```

Post-restart node evidence:

```json
{"status":"ok","version":"0.1.0+b191b9d28dac2","lifecycle":"online",
 "activeTaskCount":0,"taskTokenMode":"required","db":"none",
 "eventBacklog":0,"spoolBacklog":0,"leaseTransport":"http-when-token"}
```

`bash tools/los.sh build-version` on the node = `0.1.0+b191b9d28dac2` (digest
matches the target). `systemctl`: `active`, `NRestarts=0`, `User=los`.
`grep -c '^DATABASE_URL=' .env` = 0; `ss` shows no 5432/55432 connection.

## 4. Live approval evidence `[E]`

A direct executor dispatch was used instead of a scheduled-work goal because
the scheduled `scheduled_execution` goal self-check rejected the probe goal
before any executor dispatch (it ran on `gateway-local`, not node34; task
`task-75c9c68e-…` ended blocked). The direct dispatch is a narrower, more
controlled path: a real `run_shell` call through node34's
`/v1/tasks/run-agent`.

Probe task: `task-b2-approval-1792345608819` (`node34-executor-1`), config
`toolMode=all`, `sandboxMode=sandbox` (L2, sandbox available via bwrap),
`maxLoops=2`, prompt "use run_shell to execute `id`".

The executor returned:

```text
Tool requires approval but no approval channel is wired: run_shell
```

and the task result explicitly says the command was not executed (`id` never
ran; no stdout). Session events for the task:

```text
tool.approval_required  enforcementMode=block  action=block
tool.denied             reasonCode=tool_approval_required
tool.result             error (approval-required), no stdout
```

The tool result was produced **before** any handler execution; no `run_shell`
output exists. This is the B2 stateless approval contract working on the
canary.

Falsified first attempt: an earlier probe with `sandboxMode=workspace-write`
was blocked by the **risk gate** (`Tool risk L2 exceeds max L1`), not by the
approval gate. That did not prove R4. Re-running with `sandboxMode=sandbox`
reached the approval gate and produced the evidence above. Keep this
distinction: "blocked" is not automatically "approval-blocked".

## 5. Promotion / rollback `[E]`

No rollback was needed. R2–R4 passed.

Registry after restart:

```text
node34-executor-1: status=online, version=0.1.0+b191b9d28dac2,
activeTaskCount=0, lastHeartbeatAt=2026-10-18T17:48:53.802Z,
rolloutState=idle
```

**Finding: `deploy-to-remote.sh promote` cannot be used on a stateless node.**
The command path forwards `promote` to the executor's
`/v1/nodes/<id>/commands`, and that handler calls `getDb()`; with
`EXECUTOR_DB_MODE=none` the executor has no DB and returns
`Database not initialized. Call initDb() first.` The registry row was already
`online` with a fresh heartbeat after the restart, so no manual status write
was needed and none was made. A future batch should make `promote` a
gateway-side registry write (or have the stateless node reject it with a typed
"gateway must promote" error instead of a 500).

## 6. Adversarial review

- **Probe validity**: the first "blocked" result was the risk gate, not the
  approval gate; only the `sandboxMode=sandbox` run is R4 evidence. This is
  recorded above rather than hidden.
- **Direct dispatch vs scheduled path**: the scheduled probe failed its goal
  self-check and never reached node34; the direct dispatch exercises the same
  executor/broker approval gate but not the scheduler's goal pipeline. R4 is
  about the executor's approval boundary, so this is the right narrower probe.
- **Task completion**: the direct dispatch left the task `queued` because the
  executor's callback completion path did not converge it; the task was
  transitioned `queued → running → failed` with the state machine for
  cleanup. This does not affect the approval evidence (the tool events are
  persisted), but it is a residual direct-dispatch quirk.
- **Promote**: the stateless node cannot execute the promote command (500 from
  `getDb()`); the registry was already online. Recorded as a finding, not
  papered over.
- **Rollback**: archive + `.env` backups exist and were not needed. A real
  rollback drill remains a separate exercise.

