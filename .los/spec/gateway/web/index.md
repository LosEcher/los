# gateway/web — React Web UI Spec

## Pre-Development Checklist

- [ ] Does this change affect a page, component, or Vite config?
- [ ] Check `vite.config.ts` proxy coverage — all API routes used by the UI must be proxied
- [ ] Check `check-structure.sh` dual-track rule: no file sharing a name with a directory

## Coding Guidelines

### Vite Proxy
- `vite.config.ts` proxies API calls to the gateway backend
- Current coverage: `/chat`, `/health`, `/memory`, `/providers`, `/sessions`, `/tasks`, `/todos`
- Missing (TODO): `/runs`, `/services`, `/logs`, `/nodes` — dev mode broken for these pages
- Prefer proxy all `/api/*` or keep an explicit list that's verified by test

### Component Organization
- Pages: `src/pages/` — one file per route
- No file in `src/` may share a name with a directory (e.g., `api.ts` + `api/` → use `api/index.ts`)
- Blocked by `tools/check-structure.sh`

### Data Fetching
- Use `EventSource` for SSE streams
- Client cursor persistence is Phase D work
- Gateway URL defaults: CLI, Web footer, and Vite proxy each derive independently — centralize

## Quality Check

```bash
pnpm --filter @los/web test      # 5 tests
pnpm check                        # Structure check catches dual-track violations
```
