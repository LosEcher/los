# 2026-06-01 Executor Node Command Runner Smoke

## Observation

Gateway and executor were restarted to load the node-command proxy and executor
runner:

```bash
pnpm run restart
pnpm run executor:restart
```

The executor heartbeat for `node34` then advertised:

```json
{
  "nodeId": "node34",
  "status": "online",
  "rolloutState": "idle",
  "candidate": true,
  "commandUrl": "http://127.0.0.1:8090/v1/nodes/node34/commands",
  "nodeCommandRunner": true
}
```

## Command Proxy

Status command through the normal CLI:

```bash
./bin/los nodes command node34 status --reason "executor command proxy smoke status"
```

Observed command:

```text
node-command-9e4b293d-013d-46c4-a10f-d49b076f478a node=node34 command=status status=succeeded
  node status=online rollout=idle candidate=true
```

This proves the gateway route can use the executor-advertised `commandUrl`.

## Restart Runner

Restart command through the gateway:

```bash
./bin/los nodes command node34 restart --reason "executor command proxy smoke restart ok"
```

Observed command:

```text
node-command-ff4f83e1-9e24-4289-bac9-392f83e91c86 node=node34 command=restart status=accepted
  node status=draining rollout=draining candidate=false
  next=executor restart scheduled on owning node
```

The executor-side runner wrote to `.los-runtime/node-command-runner.log` and
executed the local helper lifecycle:

1. `draining`
2. `upgrading`
3. stop/start executor
4. `verifying`
5. `promote`
6. `idle`

The executor process changed from `pid=69655` to `pid=70294`.

Final node state:

```json
{
  "pid": 70294,
  "status": "online",
  "rolloutState": "idle",
  "candidate": true,
  "blockers": []
}
```

Runtime status after the smoke:

```text
gateway:  running pid=55621 health=ok
executor: running pid=70294 health=ok
node34:   status=online candidate=true mode=agent_http_ndjson active=0
```

## Judgment

Node maintenance commands now have a mesh-ready execution path:

1. Gateway accepts `/nodes/:id/commands`.
2. If the node advertises `connectConfig.agent_http.commandUrl`, gateway
   proxies the command to the owning executor.
3. The executor writes the command record through the shared node-command store.
4. The executor runner schedules the existing `tools/executor.sh` helper with a
   controlled PATH and runner log.
5. The node registry records the restart lifecycle and returns to scheduler
   eligibility.

`rollback` currently uses the same restart helper as a rollout-state recovery
fallback. Binary version downgrade still needs a package/version artifact model.
