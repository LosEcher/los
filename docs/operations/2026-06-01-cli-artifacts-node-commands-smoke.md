# 2026-06-01 CLI Artifact And Node Command Smoke

## Observation

After adding the CLI surfaces for artifact transfer and node commands, the
local gateway and executor were already running on the expected loopback
interfaces:

1. Gateway: `http://127.0.0.1:8080`
2. Executor node: `node34` at `http://127.0.0.1:8090`

The CLI help surfaces were available:

```bash
./bin/los artifacts --help
./bin/los nodes --help
```

## Artifact CLI

Command sequence:

```bash
./bin/los artifacts put \
  --node-id gateway-local \
  cli-artifact-20260601-2144 \
  --session cli-artifact-session-20260601-2144 \
  --content "cli artifact ok" \
  --content-type text/plain \
  --path smoke/cli.txt \
  --metadata-json '{"source":"cli-smoke"}'

./bin/los artifacts get cli-artifact-20260601-2144
./bin/los artifacts list --session cli-artifact-session-20260601-2144
./bin/los artifacts delete cli-artifact-20260601-2144 --reason "cli smoke cleanup"
```

Observed output:

1. Put returned `artifact=cli-artifact-20260601-2144`, `node=gateway-local`,
   `size=15`, checksum
   `679b239764236a420aadb10e10fd355b1a434a665aa7799196f907d7b43549eb`.
2. Get returned `cli artifact ok`.
3. List returned the artifact under
   `session=cli-artifact-session-20260601-2144`.
4. Delete returned `deleted=cli-artifact-20260601-2144`.

Session ledger evidence for `cli-artifact-session-20260601-2144` contained:

1. `artifact.put`
2. `artifact.get`
3. `artifact.delete`

## Node Command CLI

Command sequence:

```bash
./bin/los nodes command node34 status --reason "cli smoke status"
./bin/los nodes command node34 drain --reason "cli smoke drain"
./bin/los nodes command node34 promote --reason "cli smoke promote"
./bin/los nodes commands node34 --limit 3
```

Observed command ids:

1. `node-command-98480c7b-a1d2-4309-ae34-3f3a9c718cba` — `status`,
   `succeeded`
2. `node-command-be05980d-9c65-4435-911a-e9bcb03f36b1` — `drain`,
   `succeeded`
3. `node-command-30e20be3-8e28-43ea-8b00-ebd907788dda` — `promote`,
   `succeeded`

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

The CLI now exposes the gateway surfaces needed for the current single-node
agent phase:

1. Operators can put, get, list, and delete artifacts through `los artifacts`.
2. Operators can list nodes, inspect command history, and submit audited node
   commands through `los nodes`.
3. CLI artifact operations still produce durable session evidence.
4. CLI node commands mutate scheduler candidacy through the same audited API as
   direct HTTP calls.

## Remaining Work

1. Add executor-side command runner support for `restart`, `rollback`, and full
   `upgrade`.
2. Add remote executor artifact endpoints so artifacts can move gateway to node
   and node to gateway without relying on local gateway storage only.
3. Add CLI coverage tests around command parsing and renderer behavior.
