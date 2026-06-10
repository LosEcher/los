# Codex Review: los Comprehensive Project Audit (2026-06-10)

Date: 2026-06-10
Reviewer: Codex CLI v0.138.0 (model: gpt-5.5, sandbox: read-only)
Session: 019eafe5-d43b-7713-b713-d534add6b9b9
Tokens used: 278,470

## Executive Judgment

The audit is broadly accurate in its catalog of hardcoded values and its state machine inventory. However, the highest architectural risk is **not** missing state machines — it is that validated transition paths (`execution-store.ts:90`) coexist with lower-level update paths and fallback behavior that can bypass validation and outbox/event atomicity. The audit's H/M/L calibration is reasonable but underweights this bypass risk.

## Findings

### Critical (not in original audit as H): State transition enforcement is incomplete as an architectural invariant

`execution-transitions.ts:32` defines legal transitions, and `execution-store.ts:90` enforces them transactionally. But `scheduler/tool-call-state-persistence.ts:66` falls back to non-validated `updateToolCallState`, and low-level APIs in `run-specs.ts:220`, `task-runs.ts:181`, and `tool-call-states.ts:140` can mutate state directly without going through `transitionExecutionState`. Every state-changing path that does not route through the validated store is a potential drift source.

**Evidence:**
- `packages/agent/src/execution-transitions.ts:32`
- `packages/agent/src/execution-store.ts:90`
- `packages/agent/src/scheduler/tool-call-state-persistence.ts:66`
- `packages/agent/src/run-specs.ts:220`
- `packages/agent/src/task-runs.ts:181`
- `packages/agent/src/tool-call-states.ts:140`

### High: Vite proxy coverage is incomplete for the current Web UI

`vite.config.ts:11` proxies only seven route prefixes: `/chat`, `/health`, `/memory`, `/providers`, `/sessions`, `/tasks`, `/todos`. The Web UI also calls `/runs`, `/services`, `/logs`, and `/nodes` — these are not proxied. In dev mode, these calls will fail or hit the wrong endpoint.

**Evidence:**
- `packages/web/vite.config.ts:11` (7 proxied prefixes)
- `packages/web/src/pages/tasks-page.tsx:81` (calls `/runs`)
- `packages/web/src/service-page.tsx:11` (calls `/services`)
- `packages/web/src/pages/logs-page.tsx:25` (calls `/logs`)
- `packages/web/src/nodes-page.tsx:19` (calls `/nodes`)

### Medium: Runtime defaults are duplicated and can drift

The DB default appears in both `config.ts:31` (Zod schema default) and `db.ts:28` (fallback). `.env` uses port `55432` while built-ins use `5432`. The startup path (`server.ts` → `loadConfig` → `initDb(config.databaseUrl)`) correctly passes the resolved config, so this is not an immediate runtime bug — but it is a config-truth split that will cause confusion during debugging and onboarding.

**Evidence:**
- `packages/infra/src/config.ts:31`
- `packages/infra/src/db.ts:28`
- `.env:1`

### Medium: Gateway constants are hardcoded but mostly operational

`VERSION`, heartbeat interval (10s), orphan reaper interval (30s), runtime log/artifact paths, and workspace roots are hardcoded in `server.ts:50-60`. The heartbeat/reaper intervals matter because they affect recovery behavior. Path constants are lower severity unless multi-instance layout is required.

**Evidence:**
- `packages/gateway/src/server.ts:50-60`

## Severity Recalibration

| Audit Issue | Audit Rating | Codex Rating | Rationale |
|------------|-------------|--------------|-----------|
| State machine bypass paths | Not rated | **H (new)** | Non-validated update paths in scheduler persistence and low-level CRUD APIs undermine the entire state machine architecture |
| DB credentials hardcoded | H-1 | **M** | Only used as Zod default; `startServer` passes resolved `config.databaseUrl` into `initDb`, so the fallback in db.ts is not reached in normal operation |
| Vite proxy coverage gap | Not in audit | **H (new)** | Missing proxy for `/runs`, `/services`, `/logs`, `/nodes` — dev mode broken for multiple pages |
| Executor agent key | H-2 | **M** | `.env` already gitignored; executor already generates random key fallback when env var unset |
| Dual lifecycle model gap | Not in audit | **M (new)** | `run_spec.status` vs `run_contract.phase` — two independent state machines on the same entity without cross-validation |
| Port/host duplication | M-2 | **M** | Agree — duplicated but overridable through config |
| Provider URLs | M-1 | **L** | These are well-known public API endpoints; rarely change; discovery module already supports env var override |

## Missing Items

These are issues verified in source code that the audit should have caught but didn't:

1. **Dual lifecycle model**: `run_spec.status` (created/running/succeeded/failed/cancelled/blocked) and `run_contract.phase` (10 states) are two independent state machines governing the same run entity. The contract (`run-spec.yaml:85`) documents both, but there is no cross-state-machine consistency check — a run can be in `run_spec.status = 'succeeded'` while `run_contract.phase = 'executing'`. The audit mentions this fleetingly in section 5.4 but does not classify it as a risk item.

2. **Vite proxy coverage gap**: The audit catalogs `vite.config.ts` hardcoded proxy targets but does not check whether the proxy covers all routes the Web UI actually calls. Four route families (`/runs`, `/services`, `/logs`, `/nodes`) are missing from the proxy config.

3. **CLI/Web/Gateway default alignment**: CLI defaults to `http://127.0.0.1:8080` (line 22), Web App.tsx footer hardcodes the same, and Vite proxies to the same — but each derives it independently. No shared constant or env-var-driven default.

4. **Gateway startup sequence is undocumented but live-critical**: The 10-step initialization in `server.ts:172` has no corresponding documentation or ADR. If the sequence changes, there's no contract file or test that explicitly validates the order.

## Plan Assessment

A realistic remediation order should be:

1. **Make transition validation non-bypassable** — remove or constrain fallback updates in tool-call persistence and recovery paths so state changes go through `transitionExecutionState` or produce an explicit audited exception record.
2. **Fix Vite proxy coverage** — add missing route prefixes or proxy all `/api/*` paths consistently.
3. **Centralize runtime defaults** or add tests proving config/default parity.
4. **Document remaining hardcoded operational constants** with ownership and tests.

If the original plan starts with cosmetic hardcoded-value cleanup and defers state transition enforcement, it is misprioritized. The state machine bypass is architectural — it undermines the durability guarantees that Phase B0, Phase D recovery, and Phase C compaction all depend on.

## Single Most Important Action

**Fix the validated-state bypass in tool-call persistence.** Remove or constrain fallback updates in `scheduler/tool-call-state-persistence.ts` so every state change goes through `transitionExecutionState`. Low-level CRUD APIs (`updateTaskRun`, `updateRunSpecStatus`, `updateToolCallState`) should either be made private/internal or should route through the validated execution store. Without this, every durability claim (B0 enforcement, cross-gateway recovery, compaction evidence) sits on a foundation with known bypass paths.
