# los AGENTS

> Lightweight Agent Execution + Memory Management Platform.
> Single monorepo, single language (TypeScript + minimal Go for executor).
> Inspired by Codex, OpenCode, JiuwenSwarm, Hermes, ZeroClaw, IronClaw, and los-workspace.

## Architecture Principles

1. **Modular monolith** — one Node process, but each package has enforceable import boundaries
2. **Contract-first** — `contracts/` → generated types → implementation → CI validation
3. **infra/ is mandatory for cross-cutting concerns** — DB, config, logger, and provider discovery go through `@los/infra`. UI frameworks (React, Fastify), build tools (Vite, tsc), and type systems may import directly from their respective packages.
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
pnpm start            # Start gateway in background
pnpm run status       # Show gateway process and health
pnpm run stop         # Stop background gateway
pnpm run restart      # Restart background gateway
pnpm run doctor       # Check local prerequisites, config, and database
pnpm run help         # Show los local command help

pnpm dev              # Start gateway + agent
pnpm build            # Build all packages
pnpm check            # Type-check + lint + structure check
pnpm test             # Run all tests
pnpm run gate         # Full pre-push gate: check + test
pnpm run pre-push     # Shorthand for gate

# Database
pnpm --filter @los/infra db:push     # Push schema to database
pnpm --filter @los/infra db:migrate  # Run migrations
```

## OMX Tool-Level Logging

A local OMX hook plugin at `.omx/hooks/los-omx-tool-logger.mjs` captures
`PreToolUse` / `PostToolUse` events and writes structured JSONL records to
`.omx/logs/omx-<date>.jsonl` alongside `session_start`/`session_end`.

Three event types are logged:
- `tool_call` — tool invocation with input byte count and optional command preview
- `tool_result` — completed execution with exit code, duration, output byte count
- `tool_error` — failed execution with non-zero exit code

Query the log:
```bash
./tools/los-omx-tool-log.sh              # today's events
./tools/los-omx-tool-log.sh --summary    # by tool name
./tools/los-omx-tool-log.sh --errors     # errors only
./tools/los-omx-tool-log.sh --date YYYY-MM-DD
```

Redaction: raw stdout/stderr, tool arguments, auth tokens are never stored.
Only summaries (byte counts, status, timing, exit codes, command previews ≤200 chars).

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
- Gateway route modules live in `packages/gateway/src/routes/`; keep
  `packages/gateway/src/server.ts` as registration/composition, not route
  implementation. Root-level gateway `*-routes.ts` files are blocked by
  `tools/check-structure.sh`.
- Delete transitional files in the same change (no legacy/v2/temp artifacts)
- Web package: no file in `packages/web/src/` may share a name with a
  directory in the same location (e.g. `api.ts` + `api/`). Use
  `api/index.ts` instead. Blocked by `tools/check-structure.sh`.
- **Test DB schema initialization**: Every package that has DB-dependent tests
  MUST have a `test-setup.ts` that calls `initDb()` and all required
  `ensure*Store()` functions (both own-package and cross-package). Do NOT rely
  on per-file `initDb()` calls alone — `node --test` runs test files in
  parallel, and two files calling the same `ensure*Store()` simultaneously
  will race on `CREATE TABLE IF NOT EXISTS`. When adding a new store module,
  update every `test-setup.ts` in every package whose tests transitively depend
  on that store. The current package inventory:
  - `packages/agent/src/test-setup.ts` — 22 stores, all agent-owned
  - `packages/memory/src/test-setup.ts` — 2 stores (`ensureTaskRunStore`,
    `ensureRunEvalStore`), cross-depends on `@los/agent`
  - `packages/gateway/` — no `test-setup.ts`; gateway tests that need agent
    stores import `ensure*Store` ad-hoc. If a new gateway test fails with
    "relation does not exist", check whether the needed `ensure*Store()` is
    called before the test.

## AI-Assisted Change Management

This section applies to AI-assisted changes in `los`.

- Inspect changed files, understand the runtime effect, and tie the result to checks or explicit residual risk before presenting code as ready.
- When practical, finish with a repo-documented validation command or live probe and record the exact check used.
- Do not mark todo, task, session, node, or provider work as complete from UI state alone. Treat `todos` as the planning ledger, not as execution evidence. Prefer persisted evidence from `task_runs`, `session_events`, API responses, tests, or live health probes.

- Keep repo-wide operating rules in this single `AGENTS.md`. Do not add package-local `AGENTS.md` files.
- Put canonical design decisions in `docs/adr/`. Put active work queues and execution state in `todos` or project docs, not in shared/global prompt rules.
- Create a project `SKILL.md` only for repeated los-specific workflows with stable triggers, steps, evidence, and stop conditions.

- Before editing or making current-state claims, read the relevant ADR and implementation. If they disagree, treat implementation as runtime behavior and the ADR as design intent until verified.
- For API or package boundary changes, read `contracts/` first, then implementation, and verify with `./tools/check-contracts.sh` plus `pnpm check`.
- For sessions, todos, provider behavior, client flow, and node capability changes, consult the matching ADR and verify on the live surface or with the focused harness.
- Treat harnesses as quality gates for durable agent behavior, not as optional demos. When changing provider profiles, tool policy, scheduler behavior, todo dispatch, node classification, or session replay, add or update the focused test, compatibility probe, or harness assertion.
- Represent long-running work as structured `todos` when recovery or audit matters. Use the todo model to keep active work, historical evidence, and replacement or split tasks distinct.

## Reference Codebases

These are pattern references, not runtime dependencies. Do not import packages
or call services from legacy projects unless an ADR explicitly makes that
decision.

| Source | What we reuse |
|--------|--------------|
| pi `packages/ai` | Provider abstraction pattern |
| pi `packages/agent` | Agent event loop |
| los-memory | Observation/feedback model |
| vpsagentweb agent/ | Go SSH executor |
| JiuwenSwarm | FTS5 memory search pattern |
| Codex | exec mode + sandbox tiers |
| OpenCode | build/plan dual-agent concept |
