# Skill And MCP Distribution

## Current Behavior

Skills and MCP registrations have an inspect-before-apply lifecycle defined by
`contracts/skill-mcp-distribution.yaml` (0.3.0). PostgreSQL stores the current
version, an optional pin, and immutable version snapshots. A pin rejects an
update whose content-derived SHA-256 differs from the pinned version.

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
`none`, `credential_ref`, or `oauth`.

- `credential_ref` must use the same approved secret-ref shape as
  `provider_accounts.secretRef`. Supported backends after verify+enable:
  - `env:VAR` — stdio injects `{ VAR: value }` into the child env; remote
    transports set `Authorization: Bearer <value>` in-memory.
  - `local-file:los-auth/<provider-key>` — reads the access token from
    `~/.los/auth.json` providers entry; same injection rules as env.
  - `external:*` / `adapter:*` — fail-closed (`backend_not_implemented`).
- `oauth` remains fail-closed until OAuth transport exists.
- Raw environment values are rejected by the distribution API.
- List/detail/verify responses expose only `envKeys` and opaque
  `credentialRef` — never env values or header values.

SSE and streamable-HTTP registrations are executable after verify+enable when
`url` is present and auth resolves. Stdio with `authConfig.mode=none` remains
the simplest path. Tool policy is enforced during agent tool registration: deny
takes precedence, a non-empty allow list is restrictive, and the configured
L0/L1/L2 risk is passed into the normal tool registry gate.

## Verification

Focused evidence:

```bash
pnpm --filter @los/agent exec node --import tsx --import ./src/test-setup.ts --test --test-concurrency 1 src/mcp-distribution.test.ts src/mcp-credential-resolver.test.ts src/skill-distribution.test.ts
pnpm --filter @los/gateway exec node --import tsx --import ./src/test-setup.ts --test --test-concurrency 1 src/routes/tools/mcp-routes.test.ts src/routes/tools/skill-routes.test.ts
pnpm --filter @los/web test
./tools/check-contracts.sh
```

The final delivery gate is `pnpm run gate`. A live provider credential is not
required for this lifecycle; the stdio MCP probe must use a deterministic local
fixture. Remote verify coverage uses a transport-capturing MCPClient stub plus
an env-backed `credential_ref`.
