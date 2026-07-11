# los AGENTS

## Scope

`los` is a TypeScript modular monolith for agent execution and memory
management. This file contains repo-wide hard rules only. Repeated operational
workflows live in `SKILL.md`; design intent lives in `docs/adr/`; detailed active
constraints live in `docs/governance/anti-patterns.md`.

Do not add package-local `AGENTS.md` files. Global conversation, toolchain, and
cross-project execution rules remain under `~/.codex/`.

## Architecture

1. Contract first: update `contracts/`, generated types, implementation, then
   contract checks.
2. Keep one Node process with enforceable package boundaries.
3. Route DB, config, logger, and provider discovery through `@los/infra`.
4. Use Zod schemas as configuration truth and PostgreSQL for persistence.
5. Use feature flags, not experimental directories.
6. Keep source files below the CI module-size gates: over 400 lines warns and
   over 600 lines blocks.
7. Keep gateway routes under `packages/gateway/src/routes/`; `server.ts` is
   registration and composition only.
8. Do not create a file and directory with the same name under
   `packages/web/src/`.

## Read Order

Before editing or making a current-state claim:

1. Read `SKILL.md` when the task matches runtime truth, ADR reconciliation,
   provider/harness, periodic governance, or session closeout.
2. Call `loadSpecsForFiles(editableSurfaces)` for every task phase; do not rely
   on a session-start copy of `.los/spec/`.
3. Read the matching entries in `docs/governance/anti-patterns.md`, at minimum
   AP1 for state transitions, AP2 for plan persistence, and AP3 for completion.
4. Read the relevant ADR and implementation. Implementation is current runtime
   behavior; the ADR is design intent until they are verified to agree.
5. For API or package-boundary changes, read `contracts/` before source.

For workspace-boundary questions, also read `../../AGENTS.md` and
`../../WORKSPACE.md`.

## Hard Invariants

- AP1: status changes must use `transitionExecutionState()`. Direct status
  writes through `updateTaskRun()`, `updateRunSpecStatus()`, or
  `updateToolCallState()` are forbidden.
- AP2: approved plans must be persisted to `run_specs.run_contract_json` through
  `approveRunSpecPhase()` or `reviseRunSpecPlan()` before `plan_approved`.
- AP3: call `canMarkSucceeded()` and require passing verification records before
  any `succeeded` transition.
- AP5: reload applicable specs at the start of each task phase.
- AP7: run the narrow check after each meaningful code edit; do not defer all
  checks to the end of a multi-step change.
- AP9: agent identity must flow through `resolveAgentIdentity()` and
  `formatIdentityForPrompt()`, never hardcoded prompt prose.
- AP4, AP6, AP8, and AP10 remain hard constraints; their canonical wording and
  code locations are in `docs/governance/anti-patterns.md`.
- Persisted task, session, provider, node, and todo evidence outranks UI state
  or agent summaries.

## Change Rules

- Use jj for local version control. One change and one bookmark must have one
  intent; split mixed work before describing or publishing it.
- Update `contracts/` before changing public API surfaces.
- Do not add files under `packages/infra/` without package-level approval.
- Delete transitional `legacy`, `v2`, or `temp` files in the same bounded
  change after their import/export paths are verified unused.
- When adding a DB store, update every package test setup that transitively
  depends on it; parallel test files must not race on schema creation.
- Durable changes to provider profiles, tool policy, scheduler behavior, todo
  dispatch, node classification, session replay, or agent behavior require a
  focused harness, compatibility probe, regression test, or an explicit
  documented gap.
- Active work and replacement state belong in structured todos or owning project
  docs, not memory or global prompts.

## Operator Consent

Explicit operator approval is required for:

- advisory-to-trusted provider promotion
- first execution-mode use of a new stateful or cross-package tool
- memory compaction candidate promotion
- switching from audit to execution or delivery when not already authorized
- destructive remote/bookmark/workspace actions

## Commands

```bash
pnpm start
pnpm run status
pnpm run doctor
pnpm build
pnpm check
pnpm test
pnpm run gate
pnpm --filter @los/infra db:push
pnpm --filter @los/infra db:migrate
```

Use the narrowest package or focused test first. Run `pnpm run gate` when a
change crosses package boundaries or is being prepared for delivery.

## Workflow Routing

Use `SKILL.md` for:

- gateway, executor, registry, DB, and live runtime truth
- ADR/source/contract reconciliation
- provider compatibility and harness gates
- periodic governance reports
- jj, PR, mirror, bookmark, workspace, and session closeout

Session closeout must report dirty paths, change/bookmark/PR state, checks run,
checks not run, and residual risk. Never infer “shipped” or “cleaned” from
memory; verify current VCS and runtime surfaces.

## Reference Boundaries

External codebases are pattern references only. Do not import packages or call
legacy services unless an ADR explicitly establishes the dependency.
