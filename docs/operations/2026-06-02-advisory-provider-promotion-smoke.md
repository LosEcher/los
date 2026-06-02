# 2026-06-02 Advisory Provider Promotion Smoke

## Observation

Gateway and executor were running locally:

```bash
pnpm run status
pnpm executor:status
```

Observed:

```text
gateway: 127.0.0.1:8080, pid=85827, health=ok
executor: 127.0.0.1:8090, node=mbp-executor-1, health=ok
```

During the executor maintenance status check, the node reported `active=1`
because the advisory compatibility run was in progress.

## Live Readiness Surface

Command:

```bash
curl -sS 'http://127.0.0.1:8080/onboarding'
```

Observed summary:

```text
Scanned 5 tools, found 5 installed. 2 configured keys, 3 providers discovered, 2 ready, 1 manual setup blockers.
```

Provider readiness:

```text
openai    source=codex/auth.json                 configuredKey=true  ready=true
anthropic source=claude/.claude.json             configuredKey=false ready=false
deepseek  source=hermes/.env (DEEPSEEK_API_KEY)  configuredKey=true  ready=true
```

Judgment: OpenAI and DeepSeek are configured enough to be considered ready.
That does not promote either target into required compatibility gates.

## Advisory Dry Run

Command:

```bash
./bin/los compat \
  --target deepseek:deepseek-v4-pro,openai:gpt-5.5,codex:gpt-5.5,codex:gpt-5.4 \
  --probe read-context \
  --json
```

Observed planned advisory runs:

```text
deepseek:deepseek-v4-pro/read-context
openai:gpt-5.5/read-context
codex:gpt-5.5/read-context
codex:gpt-5.4/read-context
```

## Executed Advisory Target

Command:

```bash
./bin/los compat --execute \
  --target deepseek:deepseek-v4-pro \
  --probe read-context \
  --workspace . \
  --trace-prefix t11-advisory-promotion \
  --dedupe-prefix t11-advisory-promotion \
  --timeout-ms 120000 \
  --json
```

Observed summary:

```json
{
  "specId": "deepseek:deepseek-v4-pro/read-context",
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "sessionId": "session-1780413685238",
  "effectiveModel": "deepseek-v4-pro",
  "protocol": "openai",
  "reasoningSupported": true,
  "reasoningObserved": true,
  "toolCalls": ["list_directory", "read_file"],
  "toolResultCount": 2,
  "failedToolResultCount": 0,
  "deniedToolCount": 0,
  "totalTokens": 2954,
  "completed": true,
  "cancelled": false,
  "passed": true,
  "failures": []
}
```

Result identifiers:

```text
sessionId: session-1780413685238
taskRunId: task-c0928dcd-f451-4751-b068-f62a72dbceb2
traceId:   t11-advisory-promotion:deepseek:deepseek-v4-pro/read-context
requestId: req-aef7fdcc-0972-4780-8008-e5f6327b9f10
nodeId:    mbp-executor-1
```

## Persisted Evidence

Task row:

```text
status: succeeded
provider/model: deepseek / deepseek-v4-pro
toolMode: read-only
attempt: 1
workspaceRoot: /Users/echerlos/projects/los-workspace/projects/los
metadata.loopCount: 2
metadata.totalTokens: prompt=2160 completion=794
startedAt: 2026-06-02T15:21:25.289907Z
completedAt: 2026-06-02T15:21:38.302739Z
```

Observability:

```text
eventCount: 18
turnCount: 3
tools: list_directory, read_file
models: deepseek, deepseek-v4-pro
```

Persisted event sequence:

```text
task.created
task.running
session.started
tool.catalog
model.turn.started
model.response totalTokens=876  toolCallCount=2
tool.call      list_directory
tool.planned   list_directory
tool.approved  list_directory
tool.result    list_directory ok=true
tool.call      read_file
tool.planned   read_file
tool.approved  read_file
tool.result    read_file ok=true
model.turn.started
model.response totalTokens=2078 toolCallCount=0
session.completed
task.succeeded
```

## Decision

`deepseek:deepseek-v4-pro/read-context` is now a verified advisory target. It
is not promoted into `DEFAULT_COMPATIBILITY_TARGETS` in this change.

Reasons:

1. The current required target, `deepseek-v4-flash/read-context`, is already a
   lower-cost DeepSeek runtime gate.
2. One passing advisory run proves the target can be executed, but does not by
   itself justify increasing every provider/profile merge gate.
3. OpenAI/Codex advisory targets depend on OAuth-like or local auth state and
   need a separate credential/quota rule before they can become required.

Promotion from verified advisory to required should follow ADR 0017.
