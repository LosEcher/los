# 2026-06-01 Executor Artifact Endpoints Smoke

## Observation

The executor was restarted to load the new `/v1/artifacts` routes:

```bash
pnpm run executor:restart
curl -fsS http://127.0.0.1:8090/health
```

Health returned `ok` for `node34`. The node heartbeat then exposed the
executor artifact endpoint through the gateway node registry:

```json
{
  "nodeId": "node34",
  "pid": 32736,
  "artifactTransfer": true,
  "artifactsUrl": "http://127.0.0.1:8090/v1/artifacts",
  "status": "online",
  "candidate": true
}
```

## Executor Artifact Route

Command sequence:

```bash
curl -fsS -X POST http://127.0.0.1:8090/v1/artifacts \
  -H 'content-type: application/json' \
  --data '{
    "artifactId": "executor-artifact-20260601-2152",
    "sessionId": "executor-artifact-session-20260601-2152",
    "path": "smoke/executor.txt",
    "pathPolicy": "artifact-store",
    "content": "executor artifact ok",
    "contentType": "text/plain",
    "metadata": { "source": "executor-smoke" }
  }'

curl -fsS http://127.0.0.1:8090/v1/artifacts/executor-artifact-20260601-2152/content
curl -fsS 'http://127.0.0.1:8090/v1/artifacts?sessionId=executor-artifact-session-20260601-2152'
./bin/los artifacts list --node-id node34 --session executor-artifact-session-20260601-2152
curl -fsS -X DELETE http://127.0.0.1:8090/v1/artifacts/executor-artifact-20260601-2152 \
  -H 'content-type: application/json' \
  --data '{"reason":"executor smoke cleanup"}'
```

Observed output:

1. Put returned `artifactId=executor-artifact-20260601-2152`,
   `nodeId=node34`, `sizeBytes=20`, checksum
   `bcab4fbdd9b6effba30f61c82299295f57be5a0b53268ffa3516eb997df6ffff`.
2. Content readback returned `executor artifact ok`.
3. Executor list returned `executor-artifact-20260601-2152 node=node34 size=20`.
4. Gateway CLI list saw the same artifact metadata through shared PostgreSQL.
5. Delete returned `deletedAt=true`.

Session ledger evidence for `executor-artifact-session-20260601-2152` contained:

1. `artifact.put`
2. `artifact.get`
3. `artifact.delete`

## Judgment

Executor-side artifact transfer is now available independently from gateway
local storage:

1. A remote-capable executor can accept artifact uploads at `/v1/artifacts`.
2. Artifact content is stored under the executor runtime artifact directory.
3. Artifact metadata and session events still land in the shared ledger.
4. Node heartbeat advertises `capabilities.artifact_transfer=true` and the
   executor `artifactsUrl`.

This does not yet make gateway content reads proxy to a remote executor. The
gateway can list remote-node artifact metadata today; proxy read/delete is the
next integration step.

## Remaining Work

1. Add gateway proxy routes for executor-owned artifact content and delete.
2. Add executor-side command runner support for restart, rollback, and full
   upgrade.
3. Add chunked transfer for large artifacts after the basic endpoint contract is
   stable.
