# infra — Cross-Cutting Infrastructure Spec

## Pre-Development Checklist

- [ ] Is the new capability a cross-cutting concern (DB, config, logger, provider discovery)?
- [ ] Does it belong in `@los/infra` or should it live in a specific package?
- [ ] Will it be used by ≥2 packages? (gateway, agent, memory, executor)
- [ ] Is the API surface minimal (Zod schema → TypeScript type, no manual type duplication)?

## Coding Guidelines

### Config (Zod-driven)
- Single schema in `packages/infra/src/config.ts` → TypeScript types auto-derived
- Config priority: CLI flags → `.env` → `~/.los/config.yaml` → `/etc/los/config.yaml` → built-in defaults
- No hardcoded fallbacks that differ from Zod defaults (ADR 0001)

### DB (PostgreSQL)
- Always use `withDbClient()` for transactions that need atomicity
- Use `getDb()` for single-statement queries
- Schema changes: add migration, update `SCHEMA` constant, bump version
- `DATABASE_URL` is the single source of truth; no separate host/port/user/pass env vars

### Logger
- Use `getLogger('module-name')` — never `console.log` directly
- Structured logging: `log.info({key: value}, 'message')`
- Redact auth tokens, raw transcripts from log output (ADR 0016)

### Provider Discovery
- `packages/infra/src/discovery/` handles auto-detection
- Sources: `*_API_KEY` env vars, `~/.los/accounts/`, `~/.codex/accounts/`, local endpoints
- No hardcoded provider URLs outside discovery module

## Quality Check

```bash
pnpm --filter @los/infra check   # Type-check + lint
pnpm --filter @los/infra test    # 25 tests
```
