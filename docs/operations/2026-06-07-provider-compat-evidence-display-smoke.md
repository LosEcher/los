# 2026-06-07 Provider Compatibility Evidence Display Smoke

## Observation

The live gateway initially returned the Web HTML shell for
`GET /providers/compat-evidence` because the running process predated the
provider evidence route change.

Command:

```bash
pnpm run restart
curl -i http://127.0.0.1:8080/providers/compat-evidence
```

Observed after restart:

```text
started pid=51970
content-type: application/json; charset=utf-8
{"count":0,"evidence":[]}
```

Judgment: the route contract was present in source, but the live runtime was
stale. Restarting the gateway made the API route visible.

## Executed Compatibility Gate

The first live compatibility run passed but exposed a storage gap: the summary
and provider evidence did not persist `taskRunId`, `runSpecId`, `traceId`,
`requestId`, or `nodeId` even though those identifiers existed in
`session_events` and `task_runs`.

The summary extraction and evidence persistence path was fixed, then the
gateway was restarted and the gate was run again.

Command:

```bash
pnpm run restart
./bin/los compat --execute \
  --target deepseek:deepseek-v4-flash \
  --probe read-context \
  --workspace . \
  --trace-prefix p0-provider-evidence-smoke-20260607 \
  --dedupe-prefix p0-provider-evidence-smoke-20260607-v2 \
  --timeout-ms 120000 \
  --json
```

Observed summary:

```json
{
  "specId": "deepseek:deepseek-v4-flash/read-context",
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "probeId": "read-context",
  "sessionId": "session-1780821867670",
  "taskRunId": "task-82ee638c-a857-4221-8f98-9c497682b3c5",
  "runSpecId": "run-session-1780821867670-1780821867670",
  "traceId": "p0-provider-evidence-smoke-20260607:deepseek:deepseek-v4-flash/read-context",
  "requestId": "req-815c9c74-c6ae-4190-bbf7-b61e43e8f098",
  "nodeId": "mbp-executor-1",
  "effectiveModel": "deepseek-v4-flash",
  "protocol": "openai",
  "reasoningSupported": true,
  "reasoningObserved": true,
  "toolCalls": ["list_directory", "read_file"],
  "toolResultCount": 2,
  "failedToolResultCount": 0,
  "deniedToolCount": 0,
  "totalTokens": 5102,
  "completed": true,
  "cancelled": false,
  "passed": true,
  "failures": []
}
```

## API Evidence

Command:

```bash
curl -fsS 'http://127.0.0.1:8080/providers/compat-evidence?provider=deepseek&limit=3'
```

Observed:

```text
id: provider-compat-deepseek:deepseek-v4-flash/read-context
decision: verified_advisory
passed: true
sessionId: session-1780821867670
taskRunId: task-82ee638c-a857-4221-8f98-9c497682b3c5
runSpecId: run-session-1780821867670-1780821867670
traceId: p0-provider-evidence-smoke-20260607:deepseek:deepseek-v4-flash/read-context
requestId: req-815c9c74-c6ae-4190-bbf7-b61e43e8f098
nodeId: mbp-executor-1
totalTokens: 5102
toolCalls: list_directory, read_file
failedToolResultCount: 0
deniedToolCount: 0
```

## CLI Evidence

Command:

```bash
./bin/los provider list
```

Observed for `deepseek`:

```text
✓ deepseek [verified_advisory] model=deepseek-v4-flash source=hermes/.env (DEEPSEEK_API_KEY)
  evidence provider-compat-deepseek:deepseek-v4-flash/read-context
  probe=read-context
  task=task-82ee638c-a857-4221-8f98-9c497682b3c5
  run=run-session-1780821867670-1780821867670
  tokens=5102
```

## Web Evidence

The production Web bundle was rebuilt because `packages/web/dist` was older
than `packages/web/src/pages.tsx`.

Command:

```bash
pnpm --filter @los/web build
```

Observed build output:

```text
dist/assets/index-CPGQ2UwR.js
dist/assets/index-qoGw_Nju.css
```

Chrome was opened to a cache-busting URL:

```text
http://127.0.0.1:8080/?v=provider-evidence-20260607#providers
```

Observed rendered Providers text in the accessibility tree:

```text
evidence provider-compat-deepseek:deepseek-v4-flash/read-context
task task-82ee638c-a857-4221-8f98-9c497682b3c5
run run-session-1780821867670-1780821867670
tokens 5102
```

## Decision

Provider compatibility evidence is visible through API, CLI, and the Web
Providers page for the same live DeepSeek run. This does not promote DeepSeek
into a broader required provider set; it confirms that the existing required
DeepSeek gate now has operator-visible evidence.

## Remaining Risk

The Web page may show stale provider evidence if the browser keeps an older
hashed bundle cached. The gateway serves the current built `dist/index.html`;
using a cache-busting URL or hard refresh loads the latest bundle.
