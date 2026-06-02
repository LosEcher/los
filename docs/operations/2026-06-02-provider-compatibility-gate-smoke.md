# 2026-06-02 Provider Compatibility Gate Smoke

## Observation

Gateway and executor were running locally:

```bash
pnpm run status
pnpm executor:status
```

Observed before restart:

```text
gateway: 127.0.0.1:8080, pid=10637, health=ok
executor: 127.0.0.1:8090, node=mbp-executor-1, health=ok, active=0
```

The first `/onboarding` check showed the running gateway was still using an
older discovery build: provider readiness fields were absent and the summary
still said `2 providers ready to import, 1 detected but need manual setup`.

The gateway was restarted so the T-4/T-5 discovery changes were live:

```bash
pnpm run restart
```

Observed:

```text
started pid=85827
```

## Live Readiness Surface

Command:

```bash
curl -sS 'http://127.0.0.1:8080/onboarding'
```

Observed readiness summary:

```text
Scanned 5 tools, found 5 installed. 2 configured keys, 3 providers discovered, 2 ready, 1 manual setup blockers.
```

Provider readiness:

```text
openai    source=codex/auth.json                    configuredKey=true  ready=true
anthropic source=claude/.claude.json                configuredKey=false ready=false
deepseek  source=hermes/.env (DEEPSEEK_API_KEY)     configuredKey=true  ready=true
```

Anthropic blocker:

```text
BLOCKER: ANTHROPIC_API_KEY not set. Ignore if anthropic is not needed.
```

Judgment: `ready=true` means a credential/config surface is present. It does
not by itself prove the provider/model target passes the compatibility harness.

## Dry-Run Plan

Command:

```bash
./bin/los compat --json
```

Observed default target set:

```text
deepseek:deepseek-v4-flash/read-context
deepseek:deepseek-v4-flash/patch-preview
deepseek:deepseek-v4-pro/read-context
deepseek:deepseek-v4-pro/patch-preview
codex:gpt-5.5/read-context
codex:gpt-5.5/patch-preview
codex:gpt-5.4/read-context
codex:gpt-5.4/patch-preview
```

Focused gate target:

```bash
./bin/los compat \
  --target deepseek:deepseek-v4-flash \
  --probe read-context \
  --json
```

Observed: one planned run,
`deepseek:deepseek-v4-flash/read-context`.

## Executed Gate

Command:

```bash
./bin/los compat --execute \
  --target deepseek:deepseek-v4-flash \
  --probe read-context \
  --workspace . \
  --trace-prefix t6-provider-compat-rerun \
  --dedupe-prefix t6-provider-compat-rerun \
  --timeout-ms 120000 \
  --json
```

Observed summary:

```json
{
  "specId": "deepseek:deepseek-v4-flash/read-context",
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "sessionId": "session-1780406901021",
  "effectiveModel": "deepseek-v4-flash",
  "protocol": "openai",
  "reasoningSupported": true,
  "reasoningObserved": true,
  "toolCalls": ["list_directory", "read_file"],
  "toolResultCount": 2,
  "failedToolResultCount": 0,
  "deniedToolCount": 0,
  "totalTokens": 3907,
  "completed": true,
  "cancelled": false,
  "passed": true,
  "failures": []
}
```

Result identifiers:

```text
sessionId: session-1780406901021
taskRunId: task-1de5e3f5-262f-44af-8fad-19b942a9b7bc
traceId:   t6-provider-compat-rerun:deepseek:deepseek-v4-flash/read-context
requestId: req-73ddc3bc-4f89-4e41-b4df-b0f2ae7ed34e
nodeId:    mbp-executor-1
```

## Persisted Evidence

Task row:

```text
status: succeeded
provider/model: deepseek / deepseek-v4-flash
toolMode: read-only
attempt: 1
workspaceRoot: /Users/echerlos/projects/los-workspace/projects/los
metadata.loopCount: 3
metadata.totalTokens: prompt=3119 completion=788
startedAt: 2026-06-02T13:28:21.127Z
completedAt: 2026-06-02T13:28:27.429Z
```

Observability:

```text
eventCount: 20
turnCount: 3
totalTokens: 3907
tools: list_directory, read_file
models: deepseek, deepseek-v4-flash
```

Persisted event sequence:

```text
task.created
task.running
session.started
tool.catalog
model.turn.started
model.response totalTokens=818  toolCallCount=1
tool.call      list_directory
tool.planned   list_directory
tool.approved  list_directory
tool.result    list_directory ok=true
model.turn.started
model.response totalTokens=1013 toolCallCount=1
tool.call      read_file
tool.planned   read_file
tool.approved  read_file
tool.result    read_file ok=true
model.turn.started
model.response totalTokens=2076 toolCallCount=0
session.completed
task.succeeded
```

Judgment: DeepSeek `deepseek-v4-flash/read-context` is now a repeatable runtime
compatibility gate for provider/profile changes that affect current DeepSeek
behavior.

## Negative Gate Check

Command:

```bash
set +e
./bin/los compat --execute \
  --target anthropic \
  --probe read-context \
  --workspace . \
  --trace-prefix t6-provider-compat-negative-2 \
  --dedupe-prefix t6-provider-compat-negative-2 \
  --timeout-ms 30000 \
  --json
cmd_status=$?
printf 'exit_status=%s\n' "$cmd_status"
```

Observed:

```json
{
  "specId": "anthropic/read-context",
  "provider": "anthropic",
  "passed": false,
  "failures": [
    "run did not complete",
    "missing expected tool(s): list_directory, read_file"
  ]
}
```

```text
exit_status=1
```

Judgment: Anthropic remains a skipped non-fatal blocker for this workspace until
`ANTHROPIC_API_KEY` is configured. The compatibility CLI now behaves like a
gate: incomplete or failed executed probes return non-zero.

## Follow-Up

1. T-7 decided that OpenAI/Codex OAuth-like readiness stays advisory until a
   target has live compatibility evidence and an explicit promotion decision.
2. T-7 decided that the static default `los compat` target list is the required
   gate list, not a derived list of every ready provider.
3. Add a focused CLI test for non-zero exit behavior if `compatCommand` is
   refactored to be easier to invoke without process-level side effects.
