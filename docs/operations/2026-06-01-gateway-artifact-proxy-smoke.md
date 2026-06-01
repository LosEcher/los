# 2026-06-01 Gateway Artifact Proxy Smoke

## Observation

Gateway was restarted to load remote owner proxy support:

```bash
pnpm run restart
```

Executor `node34` was already advertising:

```json
{
  "artifactTransfer": true,
  "artifactsUrl": "http://127.0.0.1:8090/v1/artifacts"
}
```

## Proxy Read And Delete

The artifact was created through the executor endpoint:

```bash
curl -fsS -X POST http://127.0.0.1:8090/v1/artifacts \
  -H 'content-type: application/json' \
  --data '{
    "artifactId": "gateway-proxy-artifact-20260601-2158",
    "sessionId": "gateway-proxy-artifact-session-20260601-2158",
    "path": "smoke/gateway-proxy.txt",
    "pathPolicy": "artifact-store",
    "content": "gateway proxy artifact ok",
    "contentType": "text/plain",
    "metadata": { "source": "gateway-proxy-smoke" }
  }'
```

Gateway then read the executor-owned artifact:

```bash
curl -fsS http://127.0.0.1:8080/artifacts/gateway-proxy-artifact-20260601-2158/content
./bin/los artifacts get gateway-proxy-artifact-20260601-2158
```

Both returned:

```text
gateway proxy artifact ok
```

Gateway delete was also proxied to the executor owner:

```bash
curl -fsS -X DELETE http://127.0.0.1:8080/artifacts/gateway-proxy-artifact-20260601-2158 \
  -H 'content-type: application/json' \
  --data '{"reason":"gateway proxy smoke cleanup"}'
```

Observed output:

```text
deleted=gateway-proxy-artifact-20260601-2158 node=node34 deletedAt=true
```

Session ledger evidence for `gateway-proxy-artifact-session-20260601-2158`
contained:

1. `artifact.put`
2. `artifact.get`
3. `artifact.get`
4. `artifact.delete`

## Judgment

The artifact path now supports a minimal remote-node loop:

1. Executor accepts and stores an artifact.
2. Gateway lists metadata through shared PostgreSQL.
3. Gateway resolves the owning executor from `executor_nodes`.
4. Gateway proxies content reads and deletes to the executor `artifactsUrl`.
5. Checksum verification happens in the gateway proxy before content is
   returned to the client.

This is enough for the next mesh step to move from "single local node" to
"gateway mediated remote node artifact access". Chunking, retries, and signed
transfer URLs are still deferred.
