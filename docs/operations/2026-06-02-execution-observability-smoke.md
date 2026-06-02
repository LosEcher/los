# 2026-06-02 Execution Observability Smoke

## Observation

Gateway was already running on `127.0.0.1:8080` and healthy:

```bash
pnpm run status
```

Observed:

```text
process: running pid=10637 managed=true
health: ok
port: 8080 owned_by_pid=10637
```

The active runtime was configured for PostgreSQL at
`127.0.0.1:55432/los`, provider `deepseek / deepseek-v4-flash`, and executor
node `mbp-executor-1`.

## Chat Run

Command:

```bash
pnpm cli chat --json \
  --session session-t1-observability-20260602201024 \
  --trace-id trace-t1-observability-20260602201024 \
  --dedupe-key dedupe-t1-observability-20260602201024 \
  --tool-mode read-only \
  --max-loops 1 \
  --timeout-ms 60000 \
  "T-1 observability smoke: answer with one concise sentence and do not call tools."
```

Result identifiers:

```text
sessionId: session-t1-observability-20260602201024
taskRunId: task-ce387c26-7222-4974-bad6-3e94a2f48fda
traceId:   trace-t1-observability-20260602201024
requestId: req-81311283-0c1c-4a7f-9010-7ad896eee4c3
nodeId:    mbp-executor-1
```

The run succeeded. The model did not follow the prompt instruction to avoid
tools; it called two read-only tools:

1. `todo_list`
2. `list_directory`

That made this a useful observability smoke because the persisted evidence
included a full tool lifecycle.

## `task_runs` Evidence

Query:

```sql
SELECT id, session_id, trace_id, dedupe_key, tenant_id, project_id, user_id,
       node_id, request_id, workspace_root, tool_mode, provider, model,
       status, attempt, prompt_preview, metadata_json, created_at,
       started_at, completed_at, heartbeat_at, lease_expires_at
FROM task_runs
WHERE id = 'task-ce387c26-7222-4974-bad6-3e94a2f48fda';
```

Observed:

```text
status: succeeded
attempt: 1
tenantId/projectId/userId: local / los / local-user
nodeId: mbp-executor-1
toolMode: read-only
promptPreview: T-1 observability smoke: answer with one concise sentence and do not call tools.
metadata.totalTokens: prompt=1996 completion=570
createdAt: 2026-06-02T12:10:25.684Z
startedAt: 2026-06-02T12:10:25.714Z
completedAt: 2026-06-02T12:10:31.486Z
```

Judgment: `task_runs` is sufficient to reconstruct task identity, routing
context, node ownership, lifecycle status, timing, prompt preview, tool mode,
and aggregate token totals. It is not a full durable run spec because it does
not store the full prompt, system prompt, provider/model selection as final
columns, or stream deltas.

## `session_events` Evidence

Query:

```sql
SELECT id, turn, type, model, tool_name,
       payload_json->>'callId' AS call_id,
       payload_json->>'contentLength' AS content_length,
       usage_json->>'totalTokens' AS total_tokens
FROM session_events
WHERE session_id = 'session-t1-observability-20260602201024'
ORDER BY id;
```

Observed event sequence:

```text
171 task.created
172 task.running
173 session.started
174 tool.catalog
175 model.turn.started        model=deepseek
176 model.response            model=deepseek-v4-flash totalTokens=897 toolCallCount=2
177 tool.call                 tool=todo_list      call_00_IgfeUGtnE2sUxErrMyjP3322
178 tool.planned              tool=todo_list      call_00_IgfeUGtnE2sUxErrMyjP3322
179 tool.approved             tool=todo_list      call_00_IgfeUGtnE2sUxErrMyjP3322
180 tool.result               tool=todo_list      contentLength=2715
181 tool.call                 tool=list_directory call_01_7wiF1Hk6X12gkL0IOSQA9809
182 tool.planned              tool=list_directory call_01_7wiF1Hk6X12gkL0IOSQA9809
183 tool.approved             tool=list_directory call_01_7wiF1Hk6X12gkL0IOSQA9809
184 tool.result               tool=list_directory contentLength=371
185 session.completed         loopCount=2 totalTokens=2566 forcedSummary=true
186 task.succeeded
```

Type counts:

```text
model.response      1
model.turn.started  1
session.completed   1
session.started     1
task.created        1
task.running        1
task.succeeded      1
tool.approved       2
tool.call           2
tool.catalog        1
tool.planned        2
tool.result         2
```

The gateway API returned the same durable event set:

```bash
curl -fsS \
  'http://127.0.0.1:8080/sessions/session-t1-observability-20260602201024/events?limit=1000'
```

Observed API summary:

```json
{
  "count": 16,
  "first": "task.created",
  "last": "task.succeeded",
  "types": [
    "task.created",
    "task.running",
    "session.started",
    "tool.catalog",
    "model.turn.started",
    "model.response",
    "tool.call",
    "tool.planned",
    "tool.approved",
    "tool.result",
    "session.completed",
    "task.succeeded"
  ]
}
```

Judgment: `session_events` is sufficient to reconstruct the run lifecycle,
tool catalog, model turn start, model response summary, exact tool names,
tool call ids, policy approval decisions, tool result sizes, completion state,
request id, trace id, tenant/project/user, and executor node.

## Stream Evidence Gap

The raw SSE stream for this run contained 478 JSON lines. Its event types were:

```text
session
task
session.started
tool.catalog
model.turn.started
model.delta
model.response
tool.call
tool.planned
tool.approved
tool.result
session.completed
done
```

Database check:

```sql
SELECT count(*) AS model_delta_rows
FROM session_events
WHERE session_id = 'session-t1-observability-20260602201024'
  AND type = 'model.delta';
```

Observed:

```text
model_delta_rows: 0
```

Judgment: live `model.delta` chunks are visible in the SSE stream but are not
persisted into `session_events`. Persisted evidence can reconstruct what
happened, including tool lifecycle and final response summary, but it cannot
replay the exact token-by-token or chunk-by-chunk visible stream.

## Answer To T-1

Current `los` can reconstruct a real run from `task_runs` and
`session_events` at operation-audit granularity:

1. task lifecycle: yes;
2. session lifecycle: yes;
3. model response summary and usage: yes;
4. tool lifecycle: yes;
5. request/trace/node/tenant/project/user correlation: yes;
6. exact SSE stream replay from persisted state: no.

This means P-1/P-2 evidence risk is lower for post-run audit than the historical
review implied, but ADR 0012 Phase 3 is still needed for durable stream replay.
