# los AGENTS

> Lightweight Agent Execution + Memory Management Platform.
> Single monorepo, single language (TypeScript + minimal Go for executor).
> Inspired by Codex, OpenCode, JiuwenSwarm, Hermes, ZeroClaw, IronClaw, and los-workspace.

## Architecture Principles

1. **Modular monolith** — one Node process, but each package has enforceable import boundaries
2. **Contract-first** — `contracts/` → generated types → implementation → CI validation
3. **infra/ is mandatory** — no direct third-party imports outside `packages/infra/`
4. **Feature flags, not experimental dirs** — all features live in their target package
5. **Zod-driven config** — single schema → TypeScript types auto-derived
6. **PostgreSQL-first persistence** — single-node is treated as a one-node mesh/cloud deployment
7. **Single AGENTS.md** — no scattered rules across sub-packages
8. **Module size gates** — >400 lines warn, >600 lines block (CI enforced)

## Project Structure

```
los/
├── contracts/              # OpenAPI + JSON Schema (source of truth)
├── packages/
│   ├── infra/              # logger, config (Zod), db (PostgreSQL)
│   ├── agent/              # ReAct loop, providers, tools, sessions
│   ├── memory/             # PostgreSQL full-text memory + observations + MEMORY.md
│   ├── gateway/            # Fastify HTTP + SSE + Web UI (React)
│   └── executor/           # Go agent binary (SSH/sandbox)
├── tools/                  # check-structure.sh
└── docs/                   # adr/, research/
```

## Key Commands

```bash
pnpm dev              # Start gateway + agent
pnpm build            # Build all packages
pnpm check            # Type-check + lint + structure check
pnpm test             # Run all tests

# Database
pnpm --filter @los/infra db:push     # Push schema to database
pnpm --filter @los/infra db:migrate  # Run migrations
```

## Configuration

Config is auto-discovered from (highest to lowest priority):
1. CLI flags / process.env
2. `.env` file in working directory
3. `~/.los/config.yaml` (user profile, YAML)
4. `/etc/los/config.yaml` (system-wide)
5. Built-in defaults

Providers are auto-detected from:
- `*_API_KEY` environment variables (DEEPSEEK_API_KEY, OPENAI_API_KEY, etc.)
- `~/.los/accounts/<name>.json` (cc-switch compatible)
- `~/.codex/accounts/` (Codex compatibility)
- Local endpoints: Ollama (:11434), LM Studio (:1234), vLLM (:8000)

Database:
- `DATABASE_URL=postgres://user:pass@host:5432/los`
- Local single-node deployments use PostgreSQL too; they are treated as mesh/cloud deployments with one active node.

## Change Rules

- Keep each commit scoped to one bounded context
- Update `contracts/` before changing API surfaces
- No new files in `packages/infra/` without package-level approval
- Delete transitional files in the same change (no legacy/v2/temp artifacts)

## Reference Codebases

| Source | What we reuse |
|--------|--------------|
| pi `packages/ai` | Provider abstraction pattern |
| pi `packages/agent` | Agent event loop |
| los-memory | Observation/feedback model |
| vpsagentweb agent/ | Go SSH executor |
| JiuwenSwarm | FTS5 memory search pattern |
| Codex | exec mode + sandbox tiers |
| OpenCode | build/plan dual-agent concept |
