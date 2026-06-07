# ADR 0017: Advisory Provider Promotion Playbook

Status: Accepted

Date: 2026-06-02

## Background

ADR 0014 and T-7 split provider compatibility targets into required defaults
and advisory targets. The remaining problem is promotion: how an advisory
target earns stronger status without turning every discovered or configured
provider into a merge gate.

This ADR defines the promotion states, evidence, credential rules, and update
steps.

## Current Evidence

Live readiness on 2026-06-02:

1. Gateway `http://127.0.0.1:8080` is healthy.
2. Executor `mbp-executor-1` at `http://127.0.0.1:8090` is healthy.
3. `/onboarding` reports OpenAI and DeepSeek ready, Anthropic blocked by
   missing `ANTHROPIC_API_KEY`.
4. Required default target remains
   `deepseek:deepseek-v4-flash/read-context`.
5. Advisory `deepseek:deepseek-v4-pro/read-context` passed live compatibility
   execution with persisted `task_runs` and `session_events` evidence.

The v4-pro advisory run:

```text
target: deepseek:deepseek-v4-pro/read-context
passed: true
sessionId: session-1780413685238
taskRunId: task-c0928dcd-f451-4751-b068-f62a72dbceb2
traceId: t11-advisory-promotion:deepseek:deepseek-v4-pro/read-context
requestId: req-aef7fdcc-0972-4780-8008-e5f6327b9f10
nodeId: mbp-executor-1
totalTokens: 2954
tools: list_directory, read_file
failedToolResultCount: 0
deniedToolCount: 0
```

## Decision

`los` uses three compatibility target states:

1. **Advisory**: target can be dry-run or explicitly executed, but it is not a
   merge gate.
2. **Verified advisory**: target has at least one live passing operation record
   with `task_runs` and `session_events` evidence. It remains opt-in until a
   promotion decision changes the default gate set.
3. **Required**: target is included in `DEFAULT_COMPATIBILITY_TARGETS` and is a
   merge gate for provider/profile/model-routing changes when runtime behavior
   is affected.

`deepseek:deepseek-v4-pro/read-context` is now verified advisory, not required.
The current required default remains `deepseek:deepseek-v4-flash/read-context`.

## Promotion Criteria

Promote an advisory target to required only when all of these are true:

1. The target passes at least one live compatibility run with persisted
   `task_runs` and `session_events` evidence.
2. The credential class is suitable for unattended merge gates.
3. The model name, provider route, and expected tools are stable enough for
   repeated execution.
4. Token cost and runtime duration are acceptable for the change types that
   will trigger the gate.
5. Failure modes are actionable for the owner of the changed code.
6. The promotion updates both code and policy surfaces:
   `DEFAULT_COMPATIBILITY_TARGETS`, `ADVISORY_COMPATIBILITY_TARGETS` when
   needed, ADR 0014, and the relevant operation smoke.

One passing run is sufficient to mark a target verified advisory. It is not
sufficient by itself to make the target required.

`los provider promote` remains a setup helper for blocked provider credentials.
It does not persist required-gate policy decisions. Required promotion or
demotion should use a separate policy command only after the ADR, compatibility
harness, and target lists can be updated together.

`los provider policy promote|demote` records proposed required-gate policy
decisions with evidence links. A proposed decision is not enforcement; required
gate enforcement still requires changing the target lists, ADR text, harness
expectations, and operation evidence together.

## Credential Rule

Credential class matters:

1. API-key targets with non-interactive credentials can become required if cost
   and stability are acceptable.
2. OAuth-like credentials, local auth snapshots, or user-session credentials
   should stay advisory unless a CI-safe credential owner, refresh rule, and
   quota budget are documented.
3. Readiness from `/onboarding` proves configuration visibility. It does not
   prove compatibility or merge-gate suitability.
4. Anthropic remains advisory/blocked until `ANTHROPIC_API_KEY` is configured
   and a live compatibility run passes.

## Playbook

To evaluate an advisory target:

```bash
./bin/los compat \
  --target <provider:model> \
  --probe read-context \
  --json
```

Then execute only when credentials and quota are acceptable:

```bash
./bin/los compat --execute \
  --target <provider:model> \
  --probe read-context \
  --workspace . \
  --trace-prefix <promotion-id> \
  --dedupe-prefix <promotion-id> \
  --timeout-ms 120000 \
  --json
```

Record at least:

1. readiness surface and credential class;
2. command used;
3. compatibility summary;
4. `taskRunId`, `sessionId`, `requestId`, `traceId`, and `nodeId`;
5. event count, turn count, tools, token usage, failed tools, and denied tools;
6. decision: remain advisory, verified advisory, or promote to required.

## Implementation Implications

1. Do not add every ready provider to `DEFAULT_COMPATIBILITY_TARGETS`.
2. Keep `deepseek-v4-flash/read-context` as the required default until a
   change needs broader required coverage.
3. Keep `deepseek-v4-pro` in `ADVISORY_COMPATIBILITY_TARGETS`; its live pass is
   recorded in operation evidence, not in the default gate list.
4. Keep OpenAI/Codex targets advisory until their credential class, quota, and
   CI/non-interactive behavior are documented.
5. Keep `los provider promote` setup-only; do not overload it with required
   gate promotion or demotion.
6. Use `los provider policy promote|demote` for proposed policy decisions, then
   separately land the required target-list and harness changes when enforcing.

## Verification

Evidence used:

1. `pnpm run status`
2. `pnpm executor:status`
3. `curl -sS http://127.0.0.1:8080/onboarding`
4. `./bin/los compat --target deepseek:deepseek-v4-pro,openai:gpt-5.5,codex:gpt-5.5,codex:gpt-5.4 --probe read-context --json`
5. `./bin/los compat --execute --target deepseek:deepseek-v4-pro --probe read-context --workspace . --trace-prefix t11-advisory-promotion --dedupe-prefix t11-advisory-promotion --timeout-ms 120000 --json`
6. PostgreSQL queries against `task_runs` and `session_events` for
   `session-1780413685238`.
