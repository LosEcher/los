# 2026-06-01 Local Execution Smoke

## Observation

The repo was on `main` after the contract and planning-document batches were
pushed. Gateway and local executor were already running:

1. Gateway health: `http://127.0.0.1:8080/health` returned `ok`.
2. Executor health: `http://127.0.0.1:8090/health` returned `ok`.
3. `/nodes` showed `node34` as `candidate=true` with
   `mode=agent_http_ndjson`.
4. Gateway config had `executor.enabled=true`, `nodeId=node34`, and no static
   `meshNodes`, so scheduler selection came from `executor_nodes`.

## Executor Path

Command:

```bash
./bin/los chat \
  --provider deepseek \
  --model deepseek-v4-flash \
  --tool-mode read-only \
  --max-loops 1 \
  --timeout-ms 60000 \
  --trace-id smoke-local-executor-20260601 \
  "Reply exactly: los smoke ok"
```

Result:

1. Session: `session-1780319395288`
2. Task run: `task-2c0d3d72-560e-4f1c-bf25-61e988d89e03`
3. Node: `node34`
4. Output: `los smoke ok`
5. The live SSE stream included `model.delta`; persisted session events
   included `session.started`, `session.completed`, and `task.succeeded`.

## Gateway-Local Path

Command shape:

```bash
runScheduledAgentTask({
  prompt: "Reply exactly: los gateway smoke ok",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  toolMode: "read-only",
  maxLoops: 1,
  timeoutMs: 60000,
  traceId: "smoke-gateway-local-20260601",
  executor: { enabled: false }
})
```

Result:

1. Session: `session-1780319425385`
2. Task run: `task-c9ee4904-94a5-4660-bcb7-2f599863bdd2`
3. Node: `gateway-local`
4. Output: `los gateway smoke ok`
5. Session events included `session.started` and `session.completed`.

## Judgment

The local single-node mesh path is operational for a minimal read-only run:

1. Gateway-local execution still works.
2. Local `los-node` execution works through `agent_http_ndjson`.
3. `task_runs.node_id` and `session_events.node_id` distinguish execution
   location.
4. `/nodes` can classify the local executor as the only current execution
   candidate while keeping SSH/proxy nodes non-candidates.

## Remaining Verification

1. Run a tool-using prompt that reads a workspace file through `node34`.
2. Run a project-write patch preview/apply smoke through `node34`.
3. Verify drain removes `node34` from scheduler candidate selection.
4. Verify executor restart or upgrade records rollout state and returns to
   `candidate=true`.
5. Add an artifact-transfer smoke after the first artifact API exists.
