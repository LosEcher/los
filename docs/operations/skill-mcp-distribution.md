# Skill And MCP Distribution

## Current Behavior

Skills and MCP registrations have an inspect-before-apply lifecycle defined by
`contracts/skill-mcp-distribution.yaml`. PostgreSQL stores the current version,
an optional pin, and immutable version snapshots. A pin rejects an update whose
content-derived SHA-256 differs from the pinned version.

Skill directory imports use:

```text
POST /skills/import/inspect
POST /skills/import/apply
GET  /skills/:name/history?scope=project
POST /skills/:name/pin
POST /skills/:name/rollback
```

`/skills/load-from-dir` remains as a compatibility route, but it is preview-only
and no longer writes to PostgreSQL.

MCP registrations use:

```text
POST /mcp-servers/inspect
POST /mcp-servers
POST /mcp-servers/:id/verify
POST /mcp-servers/:id/enable
GET  /mcp-servers/:id/history
POST /mcp-servers/:id/pin
POST /mcp-servers/:id/rollback
```

`POST /mcp-servers` requires the exact `inspectedVersionHash`. Apply and
rollback leave the server disabled and unverified. Verification discovers the
tool catalog; enablement is a separate operator action.

## Security Boundary

MCP `authConfig` and `toolPolicy` are separate objects. `authConfig` accepts
`none`, `credential_ref`, or `oauth`; the latter two require an opaque
`credentialRef`. Raw environment values are rejected by the distribution API,
and list/detail responses expose only `envKeys` for legacy records.

The current executable path is verified stdio with `authConfig.mode=none`.
Credential references, OAuth, SSE, and streamable HTTP remain fail-closed until
their resolver or transport exists. Tool policy is enforced during agent tool
registration: deny takes precedence, a non-empty allow list is restrictive,
and the configured L0/L1/L2 risk is passed into the normal tool registry gate.

## Verification

Focused evidence:

```bash
pnpm --filter @los/agent exec node --import tsx --import ./src/test-setup.ts --test --test-concurrency 1 src/mcp-distribution.test.ts src/skill-distribution.test.ts
pnpm --filter @los/gateway exec node --import tsx --import ./src/test-setup.ts --test --test-concurrency 1 src/routes/tools/mcp-routes.test.ts src/routes/tools/skill-routes.test.ts
pnpm --filter @los/web test
./tools/check-contracts.sh
```

The final delivery gate is `pnpm run gate`. A live provider credential is not
required for this lifecycle; the stdio MCP probe must use a deterministic local
fixture.
