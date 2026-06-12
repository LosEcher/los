# gateway/route — HTTP Route Spec

## Pre-Development Checklist

- [ ] Is this a new route or a change to an existing route's contract?
- [ ] Update `contracts/` before changing API surfaces (AGENTS.md contract-first rule)
- [ ] Check `server.ts` for registration order dependencies

## Coding Guidelines

### Route Organization
- Route modules live in `packages/gateway/src/routes/`
- `server.ts` is registration/composition only — no route implementation
- Root-level `*-routes.ts` files outside `src/routes/` are blocked by `tools/check-structure.sh`

### API Patterns
- `POST /runs/:id/approve` — operator approval with phase validation
- `POST /runs/:id/revise-plan` — plan revision with lineage tracking
- `GET /runs/:id/events` — session event replay with `since` cursor
- `GET /runs/:id/state` — run state projection

### Error Handling
- 400: validation/contract errors with structured `{error, message}`
- 404: entity not found
- 409: version conflicts (optimistic locking)
- All errors propagated through Fastify reply chain

### SSE
- `sse-routes.ts` streams session events
- `Last-Event-ID` header support for reconnection (Phase D)
- Cursor semantics: query `since` (integer) vs SSE `Last-Event-ID` vs client persistence

## Quality Check

```bash
pnpm --filter @los/gateway test   # 33 tests (including run-routes)
pnpm check                         # Structure check catches misplaced route files
```
