# Research Tool Pack (2026-08-12)

## Goal

One documented “outside the repo” research surface (pi-web-access patterns)
without depending on Pi packages.

## Tools (built-in)

| Tool | Purpose | Risk |
| --- | --- | --- |
| `web_search` | Ranked public web results (DDG Lite) | L0 / web:read |
| `web_fetch` | GET URL → plain text | L0 / web:read |
| `http_request` | Full HTTP client when needed | higher — use sparingly |

Registration: `packages/agent/src/tools/external/web-tools.ts`.

## Operator guidance

1. Prefer `web_search` then `web_fetch` on specific URLs.
2. Do not auto-clone GitHub into the monorepo; use managed workspace if large
   code must be checked out.
3. Heavy PDF/media stay on MCP servers when configured.
4. No production dependency on `pi-web-access` npm package.

## Verification

```bash
# tools present in registry (agent unit / tool catalog events)
pnpm --filter @los/agent test
```
