---
subject: Stateless-node promote fix (gateway-side control-plane command)
auditedRev: ace51e14 (los main at batch start, 2026-10-19)
readOnly: false
method:
  - route source reading (node-command-routes.ts)
  - gateway route tests (node-command-routes.test.ts)
  - live gateway restart + node34 promote
  - executor_nodes / node_commands reads
---

# Stateless-node promote fix

Date: 2026-10-19
Context: the B2 canary rollout found that
`deploy-to-remote.sh promote` returned
`Database not initialized. Call initDb() first.` on node34 because the gateway
forwarded `promote` to the stateless executor's command endpoint, which calls
`getDb()`.

## 1. Acceptance criteria (written before the change)

### A1 — Status/promote/drain are gateway-side control-plane commands

- `POST /nodes/:id/commands` with `command=status`, `promote` or `drain`
  executes through `executeNodeCommand` in the gateway and does **not** call
  the executor's `commandUrl`.
- A node that advertises a `commandUrl` (including a dead one) still promotes
  successfully because no proxy request is made.
- `probe`, `restart`, `upgrade`, `rollback` keep their existing proxy/
  execution behavior (the proxy test now uses `probe`).

### A2 — Promote still enforces version/target checks

- `executeNodeCommand` continues to use `evaluatePromoteVersionCheck`; an
  explicit mismatched `targetVersion` is denied with 409, not silently
  promoted.

### A3 — Tests

- A route test registers a node with a dead `commandUrl`, sends `promote`, and
  asserts 202 + registry `online` + `rolloutState=idle` + no proxy.
- The existing proxy test (`status` → executor) still passes.
- The existing local drain/promote test still passes.

### A4 — Live verification on node34

- Restart the gateway from the checkout (the gateway runs `tsx` from the
  working tree) so the route change is loaded.
- Set node34's registry row to `draining` (controlled fixture), call promote,
  assert 202 and `status=online`, and confirm a `node_commands` record exists.
- No node restart and no executor deploy is required for this test.

### A5 — Docs and delivery

- Record the gateway restart (old/new pid), the live command id, and the
  registry transition.
- `pnpm --filter @los/gateway check`, route tests, doc gates pass.
- Forgejo PR, exact-head checks, merge without `force_merge`; no GitHub mirror.

## 2. Change

[node-command-routes.ts](/Users/echerlos/syncfolder/project/los-workspace/projects/los/packages/gateway/src/routes/orchestration/node-command-routes.ts)
now handles `status`, `promote` and `drain` before `proxyNodeCommand`. All
three are control-plane operations (the same `executeNodeCommand` used when no
`commandUrl` exists); forwarding them to the executor was the bug.

## 3. Tests `[E]`

```text
$ cd packages/gateway && node --import tsx --import ./src/test-setup.ts \
    --test --test-global-setup=./src/test-global-setup.mjs src/node-command-routes.test.ts
✔ node command routes drain, promote, and record commands
✔ node upgrade command records accepted rollout state...
✔ node command routes proxy to advertised executor command url
✔ stateless promote is a gateway registry write, not an executor proxy
# tests 4, pass 4, fail 0
```

## 4. Live verification `[E]`

Gateway restarted to load the checkout code:

```text
old pid=68341 → stopped
new pid=6311, /health status=ok, ready=true
```

Controlled registry fixture: node34 set to `draining` (SQL), then:

```text
POST /nodes/node34-executor-1/commands {"command":"promote",...}
HTTP 202
ok=true
commandId=node-command-5a08103f-d915-47a1-b14d-d3c2bf4b7ed1
status=succeeded
output.node.status=online
output.node.version=0.1.0+b191b9d28dac2
output.node.rolloutState=idle
executor_nodes.status=online
```

The previous failure mode (`executor node command failed: 500 ... Database not
initialized`) no longer occurs because the gateway does not call the stateless
executor for promote.

## 5. What this does not do

- It does not change `targetVersion`; node34 still records the older
  `0.1.0+bdbf387146e0b` as its target. `promote` uses `version` for the
  optional check, and the next rollout will refresh the target.
- It does not make `restart`/`upgrade` work on a stateless node; those still
  require a node-side runner. Only status/promote/drain are control-plane.
- The live gateway restart loaded the promote/drain change; the `status`
  addition landed afterwards and is unit-tested, to be loaded on the next
  gateway restart.
- It does not change the B2 approval behavior or the canary status.

## 6. Adversarial review

- **Same bug class, one more command**: `status` was still proxied and would
  hit the same `getDb()` 500 on a stateless node. It is now local too; the
  proxy test was moved to `probe` (a genuinely node-side command) so the test
  still proves the proxy path.
- **Proxy test semantics**: using `status` as the proxy fixture was masking the
  control-plane nature of status. `probe` is the right positive control.
- **Live scope**: the live promote was performed with the promote/drain change
  loaded (gateway pid 6311). The `status` addition came after that restart, so
  it is unit-tested only until the next gateway restart; this is stated rather
  than implied.
- **Registry fixture**: the live test set node34 to `draining` directly to
  exercise promote without a node restart. That is a controlled registry
  fixture, not a real drain; the command path and DB write are the same.
- **Residual**: `targetVersion` is still the older rollout target; promote
  checks `version` only. The next rollout refresh is the intended fix.
