# 2026-06-01 Artifact And Node Command Smoke

## Observation

Gateway was restarted after adding the artifact and node command APIs:

```bash
pnpm run restart
curl -fsS http://127.0.0.1:8080/health
```

Health returned `ok`.

## Artifact Transfer

Command shape:

```bash
curl -fsS -X POST http://127.0.0.1:8080/artifacts \
  -H 'content-type: application/json' \
  --data '{
    "artifactId": "live-artifact-20260601",
    "nodeId": "gateway-local",
    "sessionId": "live-artifact-session-20260601",
    "path": "smoke/live.txt",
    "pathPolicy": "artifact-store",
    "content": "artifact live ok",
    "contentType": "text/plain",
    "metadata": { "source": "live-smoke" }
  }'
```

Result:

1. Artifact id: `live-artifact-20260601`
2. Node id: `gateway-local`
3. Size: `16`
4. SHA-256:
   `962b03ca4d664f5e72e0ed4e36a5266ed08e0c92b675cfdcb2d829bfb3c03d52`
5. Content readback: `artifact live ok`
6. Delete completed with `deleteReason=live smoke cleanup`.

Session evidence for `live-artifact-session-20260601` contained:

1. `artifact.put`
2. `artifact.get`
3. `artifact.delete`

## Node Commands

Commands:

```bash
curl -fsS -X POST http://127.0.0.1:8080/nodes/node34/commands \
  -H 'content-type: application/json' \
  --data '{"command":"status","reason":"live smoke status"}'

curl -fsS -X POST http://127.0.0.1:8080/nodes/node34/commands \
  -H 'content-type: application/json' \
  --data '{"command":"drain","reason":"live smoke drain"}'

curl -fsS -X POST http://127.0.0.1:8080/nodes/node34/commands \
  -H 'content-type: application/json' \
  --data '{"command":"promote","reason":"live smoke promote"}'
```

Recorded command ids:

1. `node-command-ac93a703-587a-4ee3-acc9-317de6cd52b2` — `status`
2. `node-command-1e67a56d-59fe-4e78-a2c5-d5f29608f9e4` — `drain`
3. `node-command-ad187cda-63a5-4c81-b99f-a2aa8e798dce` — `promote`

Final node state:

```json
{
  "nodeId": "node34",
  "status": "online",
  "rolloutState": "idle",
  "candidate": true,
  "blockers": [],
  "mode": "agent_http_ndjson"
}
```

## Judgment

The first artifact and node command implementation is usable on the local
runtime surface:

1. Artifact data is written to local artifact storage and indexed in
   PostgreSQL.
2. Artifact get/delete operations append session evidence when a session id is
   present.
3. Node command requests are persisted in `node_commands`.
4. `drain` removes `node34` from scheduler candidacy.
5. `promote` restores `node34` to `candidate=true`.

## Remaining Work

1. Add remote executor artifact endpoints.
2. Add a CLI surface for artifact put/get/list/delete.
3. Add executor-side command runner for restart, rollback, and full upgrade.
4. Add a safe upgrade smoke that records `draining -> upgrading -> verifying ->
   idle` without relying only on the shell helper.
