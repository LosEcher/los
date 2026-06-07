# 2026-06-07 Run Verification And Recovery Smoke

## Observation

This smoke verifies four operator surfaces that sit on top of `run_specs`,
`verification_records`, and `tool_call_states`:

1. direct `/chat` completion blocks when required verification is unsatisfied;
2. `los run verify` executes the verifier runner and releases a blocked run;
3. `POST /runs/:id/recover` and `los run recover` expose tool-state recovery
   decisions;
4. `GET /runs/:id/state` and `los run state` display the compact run-state
   vocabulary.

The gateway and executor were live before the smoke:

```text
gateway:  http://127.0.0.1:8080 health=ok pid=62764
executor: http://127.0.0.1:8090 health=ok pid=80588 node=mbp-executor-1
```

## Direct Chat Verification Blocking

Command:

```bash
curl -sS -N -X POST http://127.0.0.1:8080/chat \
  -H 'Content-Type: application/json' \
  -d '{... "traceId":"p1-chat-verification-smoke-20260607",
         "runContract":{"requiredChecks":["node -e \"process.exit(0)\""]}}'
```

Observed `done` event:

```text
sessionId: session-1780822814728
taskRunId: task-26a0ce7a-8998-4036-8435-28078db0dbdb
runSpecId: run-session-1780822814728-1780822814728
traceId: p1-chat-verification-smoke-20260607
tokens: prompt=1777 completion=25
runSpecStatus: blocked
blockedVerificationRecordIds:
  verification-run-session-1780822814728-1780822814728-1
```

Run state before verification:

```bash
./bin/los run state run-session-1780822814728-1780822814728
```

```text
state phase=blocked action=run_verification
summary: run is blocked; next action run_verification; blockers=1
counts tasks=1 active=0 failed=0 verifications=1 blocked=1
blocker verification: required verification records are not satisfied
```

The first verifier command intentionally exposed a runtime truth difference:
the gateway verifier process did not have interactive-shell `node` on `PATH`.

```text
verification status: failed
outputSummary: /bin/sh: node: command not found
error: verification command exited with 127
```

Judgment: direct `/chat` completion correctly blocked on required verification.
The failed check is useful evidence that verifier commands must use the
gateway runtime environment, not the operator's interactive shell assumptions.

## Verifier Runner Release

The release smoke repeated the direct `/chat` pattern with an absolute Node
path:

```bash
curl -sS -N -X POST http://127.0.0.1:8080/chat \
  -H 'Content-Type: application/json' \
  -d '{... "traceId":"p1-verifier-release-smoke-20260607",
         "runContract":{"requiredChecks":["\"/Users/echerlos/Library/Application Support/fnm/aliases/default/bin/node\" -e \"process.exit(0)\""]}}'
```

Observed `done` event before verifier release:

```text
sessionId: session-1780822878492
taskRunId: task-a3e2231a-b0bf-4159-b237-4fff5bf24f34
runSpecId: run-session-1780822878492-1780822878492
traceId: p1-verifier-release-smoke-20260607
tokens: prompt=1779 completion=30
runSpecStatus: blocked
blockedVerificationRecordIds:
  verification-run-session-1780822878492-1780822878492-1
```

Verifier command:

```bash
./bin/los run verify run-session-1780822878492-1780822878492 --timeout-ms 60000
```

Observed:

```text
run=run-session-1780822878492-1780822878492 verification=succeeded ran=1
ran: verification-run-session-1780822878492-1780822878492-1
```

Run state after verifier release:

```bash
./bin/los run state run-session-1780822878492-1780822878492
```

```text
state phase=succeeded action=none
summary: run is succeeded
counts tasks=1 active=0 failed=0 verifications=1 blocked=0
```

Verification record after release:

```text
status: succeeded
outputSummary: ok
```

Judgment: `runVerificationRecordsForRunSpec` is reachable through the CLI and
gateway-backed verifier runner, and a satisfied required check releases the
run-state projection from `run_verification` to `none`.

## Tool-State Recovery Decision

A live fixture run was created through the agent package store APIs using the
same Node loader style as package tests:

```bash
pnpm --filter @los/agent exec node --import tsx --input-type=module
```

Fixture ids:

```text
sessionId: session-p1-tool-recovery-20260607-live
runSpecId: run-p1-tool-recovery-20260607-live
taskRunId: task-p1-tool-recovery-20260607-live
callId: call-p1-tool-recovery-20260607-live
toolName: read_file
state: failed
idempotent: true
attempt: 1
maxAttempts: 2
```

API command:

```bash
curl -fsS -X POST http://127.0.0.1:8080/runs/run-p1-tool-recovery-20260607-live/recover \
  -H 'Content-Type: application/json' \
  -d '{"staleMs":300000}'
```

Observed API decision:

```text
status: action_required
recommendation: retry
retryToolCallIds: call-p1-tool-recovery-20260607-live
reason: failed idempotent tool can retry attempt 2/2
```

CLI command:

```bash
./bin/los run recover run-p1-tool-recovery-20260607-live --stale-ms 300000
```

Observed CLI decision:

```text
status=action_required recommendation=retry
retryToolCallIds=call-p1-tool-recovery-20260607-live
reason: call-p1-tool-recovery-20260607-live: failed idempotent tool can retry attempt 2/2
```

Judgment: `readToolCallRecoveryForRunSpec` is exposed through both operation
routes and CLI, and it classifies retryable tool state from durable
`tool_call_states`.

## Run-State Vocabulary Display

CLI command:

```bash
./bin/los run state run-p1-tool-recovery-20260607-live
```

Observed:

```text
state phase=created action=recover_tools
summary: run is created; next action recover_tools; blockers=1
counts tasks=0 active=0 failed=0 verifications=0 blocked=0
blocker tool_recovery: tool recovery recommendation is retry [call-p1-tool-recovery-20260607-live]
```

API command:

```bash
curl -fsS http://127.0.0.1:8080/runs/run-p1-tool-recovery-20260607-live/state
```

Observed:

```text
phase: created
action: recover_tools
blockers[0].kind: tool_recovery
recovery.status: action_required
recovery.recommendation: retry
```

Inspect command:

```bash
curl -fsS http://127.0.0.1:8080/runs/run-p1-tool-recovery-20260607-live/inspect
```

Observed counts:

```text
run_spec: 1
session_event: 1
tool_call_state: 1
verification_record: 0
warnings: []
```

Judgment: the compact run-state vocabulary is visible through CLI and API and
uses the same recovery decision as the operation route.

## Scheduler Recovery Regression

The scheduler was updated so graph completion checks
`readToolCallRecoveryForRunSpec` before allowing a run spec to settle as
successful. If the recovery decision is action-required, the scheduler marks
the run spec `blocked` and writes `run.recovery_required`.

Regression command:

```bash
pnpm --filter @los/agent test
```

Observed:

```text
tests 127
pass 127
fail 0
scheduler blocks graph run completion when tool recovery is required
```

## Remaining Risk

This smoke proves blocking, release, recovery decision display, and scheduler
completion protection. Follow-up work in the same run chain added retry/resume
follow-up attempts and explicit cancel/operator-attention transitions. The
remaining risk is broader operational coverage, not the absence of those
transition surfaces.
