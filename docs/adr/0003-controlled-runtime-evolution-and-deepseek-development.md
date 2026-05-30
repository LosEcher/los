# ADR 0003: Controlled Runtime Evolution And DeepSeek-Assisted Development

## Status

Proposed.

## Observation

`los` is currently a small agent runtime with PostgreSQL persistence and a working DeepSeek provider path, but it has not yet separated scheduling, state transition, and tool capability governance into independent contracts.

Verified current surfaces:

1. `packages/agent/src/loop.ts` owns the ReAct loop, provider calls, tool execution, and session event writes.
2. `packages/agent/src/session-events.ts` already provides an append-only `session_events` ledger for model/tool/session evidence.
3. `packages/agent/src/tools/registry.ts` registers tools as `name + handler + ToolDef`; it does not yet declare permissions, side effects, idempotency, cost, or retry policy.
4. `packages/infra/src/config.ts` defaults `agent.defaultProvider` to `deepseek` and supports provider discovery.
5. Local dry-run verification on 2026-05-30 confirmed:
   - effective los config can discover an enabled DeepSeek provider with an API key;
   - `createProvider('deepseek')` succeeds;
   - PostgreSQL is reachable through the effective configured `databaseUrl`;
   - a raw `initDb()` without loaded config fails because the fallback `postgres://los:los@127.0.0.1:5432/los` role does not exist.

No live DeepSeek chat completion was executed for this record. The verification stopped before a paid/network model call.

## Inference

`los` can be used as the target runtime for DeepSeek-assisted implementation, but it should not yet be trusted as an unsupervised developer agent for its own codebase.

The current runtime has enough pieces to run:

1. prompt -> DeepSeek provider;
2. DeepSeek tool call -> built-in tool registry;
3. tool result -> loop continuation;
4. run evidence -> session event ledger;
5. final session -> session store and memory observation.

The missing controls are the parts needed before letting it freely edit the repo:

1. tool policy before `write_file` and `run_shell`;
2. per-run workspace context instead of module-global `workspaceRoot`;
3. runtime schema validation for gateway inputs and tool arguments;
4. task cancellation, timeout, retry, and dedupe semantics outside the ReAct loop;
5. typed event names and trace/causation metadata;
6. contract files for API and package boundaries.

## Judgment

Use DeepSeek through `los` in three stages, not as a single jump to autonomous implementation.

### Stage A: Dry Run And Read-Only Review

Goal: let `los` call DeepSeek with read/list tools only.

Required constraints:

1. disable or hide `write_file` and `run_shell`;
2. preserve `session_events`;
3. require explicit workspace root per run;
4. expose the event timeline for each session.

Accept when:

1. a session records `session.started`, `model.response`, `tool.call`, `tool.result`, and `session.completed`;
2. no file writes or shell commands can happen through the tool catalog;
3. the same prompt can be reviewed from `/sessions/:id/events`.

### Stage B: Supervised Patch Mode

Goal: let `los` prepare bounded code changes, but require external approval before side effects.

Required constraints:

1. add `ToolCapability` metadata for built-in tools;
2. classify `write_file` and `run_shell` as side-effecting;
3. add policy checks before side-effecting tools;
4. add timeout and cancellation for tool execution;
5. write planned actions to the event ledger before executing them.

Accept when:

1. side-effecting tools can be denied by policy;
2. a denied tool call produces a structured `tool.result` event;
3. file edits are traceable to a session, turn, tool call, and payload preview;
4. `pnpm check` still passes.

### Stage C: Controlled Implementation Runs

Goal: allow `los` to execute implementation tasks with DeepSeek under explicit task boundaries.

Required constraints:

1. introduce `TaskRun` with `id`, `status`, `dedupeKey`, `traceId`, `createdAt`, `updatedAt`;
2. introduce a minimal scheduler wrapper around `runAgent`;
3. persist task lifecycle events;
4. add retry policy only for idempotent tools;
5. keep human approval for high-risk shell commands and broad file writes.

Accept when:

1. a failed run can be inspected without relying on terminal logs;
2. a duplicate task can be refused or linked to the original run;
3. cancellation stops new model/tool work;
4. the implementation diff can be attributed to task and session evidence.

## Task Split

### P0: Record And Guardrails

1. Keep this ADR as the baseline decision record.
2. Add a read-only tool mode or tool allowlist to `AgentConfig`.
3. Remove module-global workspace mutation from the tool runtime path.
4. Add tests for tool allowlist and path isolation.

### P1: Event Contract Tightening

1. Define `SessionEventType` as a typed union.
2. Add `traceId`, `domain`, and `causationId` to `SessionEventWrite`.
3. Add event projection tests for model, tool, cache, and session summaries.
4. Keep raw event payload redaction in the append path.

### P2: Capability Runtime

1. Add `ToolCapability` beside provider-facing `ToolDef`.
2. Add `sideEffect`, `permissions`, `timeoutMs`, `retryable`, `idempotent`, and `costLevel`.
3. Enforce capability policy before invoking handlers.
4. Emit `tool.denied` or structured denied `tool.result` events.

### P3: Task Scheduler Shell

1. Introduce `TaskRun` persistence.
2. Wrap `runAgent` behind a scheduler entrypoint.
3. Add `dedupeKey`, cancellation, timeout, and basic status transitions.
4. Keep the first scheduler single-process and PostgreSQL-backed.

### P4: Contract Gate

1. Add actual OpenAPI or JSON Schema files under `contracts/`.
2. Generate or validate TypeScript types from contracts.
3. Update `tools/check-contracts.sh` so API/package boundary drift fails the gate.
4. Align the documented contract-first rule with the real CI check.

## Direct DeepSeek Development Feasibility

Current answer: possible for controlled experiments, not yet safe for broad self-modifying implementation.

Use immediately for:

1. architecture review prompts;
2. code reading and summarization;
3. read-only task planning;
4. generating proposed patches outside automatic execution.

Do not use yet for:

1. unattended repo edits;
2. broad shell execution;
3. multi-file refactors without a policy gate;
4. tasks needing cancellation/retry/recovery guarantees.

The first practical implementation milestone is not "make los autonomous"; it is "make los able to run DeepSeek in read-only and supervised patch modes with complete event evidence."

## Verification Commands

Commands used for this record:

```bash
pnpm check
./tools/check-contracts.sh
node --input-type=module -e "import { loadConfig, printConfigDiagnostics } from './packages/infra/dist/config.js'; const cfg = await loadConfig(); console.log(printConfigDiagnostics(cfg)); console.log('deepseek_enabled=' + Boolean(cfg.providers.deepseek?.enabled)); console.log('deepseek_has_key=' + Boolean(cfg.providers.deepseek?.apiKey));"
node --input-type=module -e "import { loadConfig } from './packages/infra/dist/config.js'; import { initDb, closeDb } from './packages/infra/dist/db.js'; const cfg = await loadConfig(); try { await initDb(cfg.databaseUrl); console.log('configured_db_init=ok'); } catch (err) { console.log('configured_db_init=fail'); console.log(String(err?.message ?? err)); } finally { await closeDb().catch(()=>{}); }"
pnpm --filter @los/gateway exec tsx -e "import { loadConfig } from '@los/infra/config'; import { createProvider } from '@los/agent'; (async () => { try { await loadConfig(); const p = createProvider('deepseek'); console.log('create_deepseek_provider=ok'); console.log('provider_name=' + p.name); } catch (err) { console.log('create_deepseek_provider=fail'); console.log(String((err as Error)?.message ?? err)); } })();"
```

Observed verification result:

1. `pnpm check` passed with one existing structure warning: `packages/infra/src/discovery.ts` is 618 lines.
2. `./tools/check-contracts.sh` passed.
3. effective config reported DeepSeek enabled and key present without printing the key.
4. configured PostgreSQL connection succeeded.
5. `createProvider('deepseek')` succeeded.

## Implementation Note: 2026-05-30 P0 Start

Implemented:

1. `AgentConfig` now supports `toolMode: 'all' | 'read-only'` and `allowedTools`.
2. `toolMode: 'read-only'` only exposes `read_file` and `list_directory`.
3. `registerBuiltinTools()` now receives `workspaceRoot` per registry instead of relying on mutable module-global workspace state.
4. Disallowed tools are omitted from the provider-facing tool catalog and return `Tool not allowed: <name>` if invoked directly.
5. Built-in path resolution now uses `path.relative()` boundary checks to avoid prefix-based workspace escapes.
6. Agent tests cover read-only tool filtering and per-registry workspace isolation.

Verification after implementation:

```bash
pnpm --filter @los/agent test
pnpm check
./tools/check-contracts.sh
```

Result:

1. agent tests passed: 2 tests.
2. `pnpm check` passed with the existing `packages/infra/src/discovery.ts` size warning.
3. workspace gate passed.

Remaining after P0 start:

1. Add a user-facing Gateway/API path for selecting read-only or supervised tool mode.
2. Decide whether deprecated `setWorkspaceRoot()` should be removed from the public export in a breaking cleanup.
3. Move from allowlist-only control to `ToolCapability` metadata in P2.

## Implementation Note: 2026-05-30 Gateway Project Mode

Implemented:

1. `/chat` now accepts `workspaceRoot`, `toolMode`, `allowedTools`, and `maxLoops`.
2. The gateway defaults `workspaceRoot` to the los repo root when the caller does not provide one.
3. Session metadata now records the selected workspace root and tool mode.
4. The HTML chat page exposes workspace root, tool mode, and max loop controls.

Verification after gateway update:

```bash
pnpm check
pnpm --filter @los/gateway build
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/ | rg -n "workspace-root|tool-mode|max-loops"
```

Result:

1. both commands passed.
2. the only existing workspace warning remains `packages/infra/src/discovery.ts` at 618 lines.
3. the live gateway responded on `127.0.0.1:8080`.
4. the page contains workspace root, tool mode, and max loop controls.
5. `POST /chat` with an empty body returns HTTP 400.

## Implementation Note: 2026-05-30 lsclaw Capability Borrowing

Reference inspected:

1. `projects/lsclaw/control-plane/src/state/tool-capability.mjs`
2. `projects/lsclaw/control-plane/src/agent/tool-executor.mjs`
3. `projects/lsclaw/control-plane/src/state/task-policy.mjs`
4. `projects/lsclaw/control-plane/src/model/provider-router-adapters.mjs`
5. `projects/lsclaw/control-plane/src/agent/coordinator.mjs`

Borrowed into los:

1. `ToolCapability` metadata shape for built-in tools.
2. `L0/L1/L2` risk levels:
   - `L0`: read-only tools.
   - `L1`: workspace writes.
   - `L2`: shell/CLI execution.
3. Capability fields: permissions, timeout, retryable, idempotent, cost level, side effect, sandbox requirement, approval hint, tags.
4. A pre-handler capability check before tool execution.
5. `project-write` mode: allows L0/L1 project file work but blocks L2 shell execution.

Not borrowed yet:

1. Full approval persistence and callback workflow.
2. Tenant/user scoped approval contracts.
3. Durable task queue, leases, and retry backoff.
4. Runtime cancellation controllers.
5. DeepSeek prefix-cache message partitioning.
6. Attempt/read-model reconstruction for mixed runtime events.

Implementation result:

1. `packages/agent/src/tools/registry.ts` now stores capability metadata beside each handler and provider-facing tool definition.
2. `createToolRegistry()` accepts a `ToolExecutionPolicy`.
3. `runAgent()` supports `toolMode: 'read-only' | 'project-write' | 'all'`.
4. The Gateway `/chat` endpoint and UI support `project-write`.
5. Tests cover:
   - read-only mode blocks writes and shell;
   - workspace roots are isolated per registry;
   - project-write mode allows `write_file` but blocks `run_shell`.

Verification:

```bash
pnpm --filter @los/agent test
pnpm check
```

Result:

1. agent tests passed: 3 tests.
2. full check passed with the existing `packages/infra/src/discovery.ts` size warning.

## Implementation Note: 2026-05-30 Tool Decision Events

Implemented:

1. `ToolRegistry` now exposes `evaluateTool(name)` so policy decisions can be inspected before handler execution.
2. `runAgent()` now emits:
   - `tool.planned` before capability enforcement;
   - `tool.approved` when the tool is allowed;
   - `tool.denied` when policy blocks the tool;
   - `tool.result` with `denied: true` for blocked calls.
3. Tool decision events include capability summary and effective tool policy.
4. Blocked tools no longer require handler execution to produce audit evidence.

Verification:

```bash
pnpm --filter @los/agent test
pnpm check
./tools/check-contracts.sh
```

Result:

1. agent tests passed: 3 tests.
2. full check passed with the existing `packages/infra/src/discovery.ts` size warning.
3. workspace gate passed.

## Implementation Note: 2026-05-30 Minimal Scheduler Shell

Implemented:

1. `packages/agent/src/task-runs.ts` now persists `traceId`, `dedupeKey`, `attempt`, `startedAt`, and `completedAt`.
2. `findActiveTaskRunByDedupeKey()` returns active `queued`/`running` task runs for dedupe checks.
3. `packages/agent/src/scheduler.ts` wraps `runAgent()` with a single-process task lifecycle shell.
4. The scheduler emits `task.created`, `task.running`, `task.succeeded`, `task.failed`, and `task.deduplicated` session events.
5. `packages/gateway/src/server.ts` now routes `/chat` through the scheduler instead of creating task lifecycle rows inline.
6. `/chat` accepts `traceId` and `dedupeKey` so callers can correlate and dedupe project tasks.

What this does not do yet:

1. No timeout controller interrupts `runAgent()` mid-flight.
2. No retry policy is enforced at the scheduler layer.
3. No cancellation endpoint is wired through the new scheduler shell.

Verification:

```bash
pnpm --filter @los/agent exec node --import tsx --test src/task-runs.test.ts
pnpm check
```

Result:

1. `task-runs` persistence test passed.
2. full check passed with the existing `packages/infra/src/discovery.ts` size warning.
3. the new scheduler path compiled cleanly in `packages/gateway` and `packages/agent`.

## Implementation Note: 2026-05-30 Scheduler Cancellation And Timeout

Implemented:

1. `AgentConfig` now accepts an `AbortSignal`.
2. `runAgent()` checks abort state before model/tool work and wraps model/tool promises so a scheduler timeout or cancel request can release the caller.
3. `runScheduledAgentTask()` accepts `timeoutMs`, registers a per-task `AbortController`, and returns `status: 'cancelled'` when the task is aborted.
4. `cancelScheduledTask(taskRunId, reason)` cancels a live in-process scheduled task.
5. `packages/gateway/src/server.ts` accepts `timeoutMs` in `/chat` and exposes `POST /tasks/:id/cancel`.
6. Cancelled tasks persist `status: 'cancelled'` and emit `task.cancelled`.

Current limitation:

1. Provider fetches and synchronous shell handlers may continue at the underlying runtime layer after the caller is released.
2. `project-write` still blocks shell execution, so this limitation mainly affects model calls until provider-level abort signals are added.
3. Cancellation is process-local; a restarted gateway cannot interrupt a task that was in memory before restart.

Verification:

```bash
pnpm --filter @los/agent check
pnpm --filter @los/gateway check
pnpm --filter @los/agent exec node --import tsx --test src/task-runs.test.ts
pnpm check
```

Result:

1. checks passed.
2. `task-runs` persistence test passed.
3. full check passed with the existing `packages/infra/src/discovery.ts` size warning.

## Implementation Note: 2026-05-30 Provider Abort And Tool Timeout

Implemented:

1. `Provider.chat()` now accepts `ChatOptions.signal`.
2. OpenAI-compatible and Anthropic provider adapters pass that signal to `fetch()`.
3. `runAgent()` forwards the scheduler's abort signal into provider calls.
4. `ToolRegistry.execute()` enforces `ToolCapability.timeoutMs` around async handlers.
5. `run_shell` clamps its internal timeout to the declared capability ceiling.
6. `packages/agent/src/tools/registry.test.ts` now covers timeout enforcement.

Why this matters:

1. scheduler cancellation now reaches the network layer instead of only returning early in the caller;
2. tool capability metadata now constrains execution, not just documentation;
3. timeout behavior is visible in tests before adding retries.

Verification:

```bash
pnpm --filter @los/agent test
pnpm check
```

Result:

1. agent tests passed: 4 tests.
2. full check passed with the existing `packages/infra/src/discovery.ts` size warning.
