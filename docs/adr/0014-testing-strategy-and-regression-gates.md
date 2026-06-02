# ADR 0014: Testing Strategy And Regression Gates

## Status

Accepted.

## Background

The 2026-06-02 historical review initially treated `los` as if it had zero
tests. Current source truth is different: excluding `node_modules/` and
`dist/`, `packages/**/src` contains 19 source test files and about 673KB of
source code.

The real gap is not "no tests." The gap is that tests, compatibility harnesses,
contract checks, and operation smokes are not assigned to change types. Without
that assignment, later changes can pass a generic command while still missing
the evidence surface that matters for the behavior being changed.

## Current State

Checked on 2026-06-02:

```text
source files by package:
  agent     33
  cli        6
  executor   4
  gateway   16
  infra      6
  memory     4
  web       10

source test files by package:
  agent      8
  cli        1
  executor   1
  gateway    5
  infra      2
  memory     1
  web        1
```

Current source test files:

```text
packages/agent/src/compat-harness.test.ts
packages/agent/src/executor-nodes.test.ts
packages/agent/src/model-profiles.test.ts
packages/agent/src/model-settings.test.ts
packages/agent/src/scheduler.test.ts
packages/agent/src/service-instances.test.ts
packages/agent/src/task-runs.test.ts
packages/agent/src/tools/registry.test.ts
packages/cli/src/client-path.test.ts
packages/executor/src/node-command-runner.test.ts
packages/gateway/src/artifact-routes.test.ts
packages/gateway/src/node-command-routes.test.ts
packages/gateway/src/node-routes.test.ts
packages/gateway/src/service-routes.test.ts
packages/gateway/src/ssh-config-import.test.ts
packages/infra/src/config.test.ts
packages/infra/src/discovery.test.ts
packages/memory/src/markdown.test.ts
packages/web/src/ui-boundary.test.mjs
```

Current package scripts:

1. `@los/agent`, `@los/gateway`, `@los/cli`, `@los/web`, `@los/infra`,
   `@los/memory`, and `@los/executor` define `test` scripts.
2. Root `pnpm check` runs Turbo check, `tools/check-structure.sh`, and
   `tools/check-contracts.sh`.
3. Root `pnpm test` runs Turbo test.

Current non-test gates:

1. `tools/check-contracts.sh` checks presence and minimum fields for
   `run-spec`, `run-stream`, `node-registry`, `node-command`, and
   `artifact-transfer`.
2. `tools/check-structure.sh` warns on large files, flat directories,
   process-phase filenames, and direct third-party imports outside
   `packages/infra`.
3. Operation smoke docs under `docs/operations/` record live evidence for
   local execution, artifact transfer, node commands, service readiness, and
   execution observability.
4. `packages/agent/src/compat-harness.ts` and `los compat` provide a model and
   provider comparison surface. T-6 verified DeepSeek
   `deepseek-v4-flash/read-context` as the current executable runtime gate.

## Decision

`los` will use four verification layers. Each layer answers a different
question and should not be treated as interchangeable.

1. **Unit and package tests**
   - Question: did a module preserve local semantics and edge cases?
   - Surface: `packages/*/src/*.test.*`, package `pnpm --filter ... test`.

2. **Contract and structure gates**
   - Question: did public contracts, package boundaries, and structural rules
     remain coherent?
   - Surface: `pnpm check`, `tools/check-contracts.sh`,
     `tools/check-structure.sh`.

3. **Compatibility harnesses**
   - Question: does a provider/model/tool policy behave the same way on a
     fixed task surface?
   - Surface: `los compat`, `packages/agent/src/compat-harness.ts`, and future
     focused harness assertions.

4. **Operation smokes**
   - Question: did the live runtime path work against current gateway,
     executor, PostgreSQL, provider, and node state?
   - Surface: `docs/operations/YYYY-MM-DD-*.md` with exact commands,
     identifiers, and observed results.

## Required Gates By Change Type

| Change type | Minimum gate | Additional gate when risk rises |
|-------------|--------------|----------------------------------|
| Pure docs or ADR update | Source-grounded readback | `./tools/check-contracts.sh` when claims mention contracts or package boundaries |
| Package-local pure function or parser | Focused package test | Root `pnpm check` when exported APIs or imports change |
| `contracts/` or API route shape | `./tools/check-contracts.sh` + focused route test | `pnpm check` |
| `packages/agent` scheduler, task runs, session events, todos, tools, or model profiles | Focused `@los/agent` test | `los compat` or operation smoke when provider/tool behavior changes |
| `packages/gateway` routes or request context | Focused `@los/gateway` test | Live curl/CLI smoke when SSE, persistence, or service readiness changes |
| `packages/executor` runtime or maintenance command path | `pnpm --filter @los/executor check` | Live executor smoke and node-command evidence |
| Provider/profile/model routing | Focused model/profile tests | `./bin/los compat --execute --target deepseek:deepseek-v4-flash --probe read-context --workspace . --timeout-ms 120000` when behavior is runtime-visible; add targets only when their readiness and compatibility are proven |
| Node registry, node commands, service registry, artifact transfer | Focused package tests + `pnpm check` | Operation smoke with DB/API evidence |
| Run replay, stream persistence, or session observability | Focused event projection tests | Operation smoke proving `task_runs` and `session_events` evidence |
| UI page behavior | Focused web test or typecheck | Browser/manual smoke only when layout or live API behavior changes |

## Coverage Expectations

Coverage percentage is not the first control for this project. The initial
control is required evidence by behavior.

The following modules require source tests for new behavior:

1. persistence stores: `task_runs`, `session_events`, `executor_nodes`,
   `service_instances`, artifacts, todos, node commands;
2. policy boundaries: tool registry, approval/tool mode, workspace path safety,
   provider/model profile normalization;
3. request and replay boundaries: idempotency, request context, session resume,
   SSE event projection;
4. command parsing and path normalization in CLI;
5. UI boundary tests for views that gate operational actions.

The following behavior requires harness evidence:

1. provider/model profile compatibility;
2. malformed tool call repair;
3. read-only versus project-write tool availability;
4. timeout, cancellation, retry, and failed-tool handling;
5. provider usage/cost/event projection.

The following behavior requires operation smoke evidence:

1. live `/chat` through gateway and/or executor;
2. service readiness, drain, promote, and multi-gateway routing;
3. executor restart, drain, promote, upgrade, and rollback paths;
4. artifact upload/download/delete through executor and gateway proxy;
5. stream replay, once ADR 0012 Phase 3 starts.

## Gaps To Close

1. Executor package test entry is now present:
   `packages/executor/src/node-command-runner.test.ts` covers the maintenance
   command runner's helper-script boundary before real restart/upgrade work is
   added.
2. Memory package source test is now present:
   `packages/memory/src/markdown.test.ts` covers deterministic `MEMORY.md`
   synchronization and missing-file reads before changing memory writes or
   search.
3. Root `pnpm test` is available but not yet named in the merge rule. Use it
   for broad shared behavior changes and before publishing larger batches.
4. The current required provider runtime gate is DeepSeek
   `deepseek-v4-flash/read-context`. OpenAI/Codex OAuth-based readiness and
   Anthropic API-key readiness remain advisory until each target has live
   compatibility evidence and an explicit policy decision to promote it into
   `DEFAULT_COMPATIBILITY_TARGETS`. `deepseek-v4-pro/read-context` has live
   passing evidence and is now verified advisory, but it is not a required
   default gate.
5. Operation smoke docs should state whether they prove live runtime behavior,
   persisted DB evidence, live SSE evidence, or all three.

## Non-Goals

1. Do not require full repo `pnpm test` for every documentation-only edit.
2. Do not treat operation smokes as replacements for deterministic unit tests.
3. Do not treat `pnpm check` as proof of live provider, executor, or database
   behavior.
4. Do not promote coverage percentage as the main release signal before the
   behavior-specific gates above are in place.

## Verification

This ADR is a policy/documentation change. Required verification for this
change:

```bash
./tools/check-contracts.sh
```

Recommended verification after this ADR:

```bash
pnpm test
```

`pnpm test` should be run before the next implementation change that touches
shared runtime behavior, providers, scheduler state, persistence, or gateway
routes.
