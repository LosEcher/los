# Executor Node

`@los/executor` is a real los node process. It runs the agent loop outside the
gateway process, heartbeats into PostgreSQL, and renews task leases while it
executes assigned work.

## Run

```bash
EXECUTOR_PORT=8090 \
EXECUTOR_NODE_ID=local-node-1 \
EXECUTOR_NODE_URL=http://127.0.0.1:8090 \
pnpm --filter @los/executor dev
```

Point the gateway at the node:

```bash
EXECUTOR_ENABLED=true
EXECUTOR_MESH_NODES=http://127.0.0.1:8090
```

Optional shared-key auth:

```bash
EXECUTOR_AGENT_KEY=shared-secret
```

## HTTP Contract

- `GET /health` returns node identity and liveness.
- `POST /v1/tasks/run-agent` runs one assigned agent task and returns the
  persisted session events plus the final `AgentResult`.

The gateway remains responsible for creating and completing `task_runs`. The
executor owns node heartbeat and per-task lease renewal while the task is
running.
