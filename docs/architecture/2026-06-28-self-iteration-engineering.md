# Self-Iteration Engineering: Findings, Topology & AST/KG-Driven Plan

**Date**: 2026-06-28
**Status**: Record + plan. Arc PR #87–#91 merged; this generalizes the pattern.

## Context

The migration-drift saga (PR #87–#91) produced a working **oracle-driven self-iteration loop**: detect (drift gate) → TODO (GA Loop job) → fix (Claude agent via /pr-self-merge) → verify (gate baseline shrinks) → resolve (TODO auto-archives). This document records the findings from that arc and generalizes the pattern into an engineering approach: use AST + knowledge-graph to structurally parse topology + timing, discover structural debt, and fix it iteratively — walking the main runtime event flow module by module.

## 1. Consolidated findings

### 1.1 DB layer — two sources of truth (PR #87–#91, resolved)
- **Root cause**: migrations (25 files) and `ensure*Store` (32 functions) were two unsynchronized schema sources; `ensure*Store` was the real bootstrap, migrations were partial drafts. Drift accumulated because `ensure*Store` self-heals (`ADD COLUMN IF NOT EXISTS`) so the live DB was always correct → no pressure to maintain migrations.
- **Resolution**: gate (PR #89) prevents new drift; `ensureAllStores` at startup (PR #90) self-heals all 32 tables; `migration_drift_fix` job (PR #91) turns the 367 grandfathered drift entries into a TODO worklist a Claude agent works modularly.
- **Antipattern**: [[los-implemented-but-not-wired-antipattern]] (DB flavor) + two-source-of-truth.

### 1.2 Package topology (clean)
```
@los/infra  ← root (db, config, logger, provider discovery)
   ↑
@los/input-preprocessor  ← @los/infra
   ↑
@los/agent  ← hub (loop, scheduler, tools, governance, stores)
   ↑↑          ↑
@los/memory  @los/executor   ← two consumers, mutually independent
   ↑              (no migrateDir/ensureAllStores at startup — see 1.3)
@los/gateway  ← top of stack (depends on agent+memory+infra; owns ensureAllStores)
   ↑ HTTP
@los/web  ← independent frontend
```
Package DAG and call-graph clusters (KG: 12 clusters) align — no unexpected cross-package coupling. Healthy.

### 1.3 Executor bootstrap blind spot (OPEN — highest priority)
- `packages/executor/src/index.ts startExecutor`: `initDb` + only `ensureExecutorNodeStore` + `ensureArtifactStore`. **No `migrateDir`, no `ensureAllStores`**. Remote executor nodes with own DBs get partial schema (only 2 tables ensured; rest lazy-or-missing).
- `startExecutor` is also the **worst structural hotspot** in the codebase: `transitive_loop_depth = 9` (KG) — deepest nested-loop degree. Dual failure: topology gap + complexity hotspot.
- Local dev masks it (gateway+executor share one DB; gateway's `ensureAllStores` covers it).

### 1.4 Main runtime event flow (KG trace from `runChat`)
```
runChat (chat-service)
  → session (ensure/save/load) · run-specs (createRunSpec) · memory (compactSession, recordSelfReflection, addObservation)
  → persist (persistChatSuccess, persistStreamCheckpoint) · live-events (emit/relay)
  → scheduler.runScheduledAgentTask (tld=7 hotspot) → recordSchedulerDecision · dead-letter
  → task-runs (createTaskRun, updateTaskRunFields) · abort-registry · run-contract.canStartExecution
  → run-evals.recordFailoverEval · goal-self-check · execution-store.transitionExecutionState
  → loop.runAgent → setupAgentRun / runPreExecutionPhases / runToolCalls
  → executor-client (resolveExecutor, runAgentOnExecutor) → contract-reader.checkVerificationGate
  → chat-run-completion · chat-memory-augment · chat-session-helpers
```
This is the spine to walk module-by-module.

### 1.5 Structural hotspots (KG: transitive_loop_depth ≥ 3)
| Function | File | tld | lsl | note |
|---|---|---|---|---|
| startExecutor | executor/src/index.ts | **9** | 0 | bootstrap blind spot + worst hotspot |
| runScheduledAgentTask | agent/src/scheduler/scheduled-task-runner.ts | 7 | 0 | core event-flow scheduler |
| streamAssignedAgentTask / runAssignedAgentTask | executor/src/index.ts | 7 | 0 | executor event flow |
| runPostExecutionSelfCheck | agent/src/self-check.ts | 5 | 0 | |
| governance-status-constraints.*WithDefaultDb | agent/src/governance-status-constraints.ts | 5 | 0 | |
| withInitDb | infra/src/db.ts | 5 | 0 | |
| review-runner.runMultiRoleReview/runSingleReviewRole | agent/src/review-runner.ts | 5 | 0 | |
| file-sync/periodic.startPeriodicSync/refreshAndSchedule | executor/src/file-sync/periodic.ts | 5/4 | 0 | |
| loop/compression.compressOrTrimMessages | agent/src/loop/compression.ts | 4 | 0 | |
| code-intel.extractSymbols | agent/src/tools/builtin/code-intel.ts | 3 | **1** | hidden O(n²) (linear scan in loop) |

### 1.6 Other structural debt (from memory + GA jobs)
- **Implemented-but-not-wired**: 6 occurrences in 7 days (memory `los-implemented-but-not-wired-antipattern`). GA Loop's `consistency_audit` catches the DB/todo flavor; no general code-level detector.
- **File-size**: 30 files >400 lines (grandfathered, warn-only gate; `file_size` GA job reports but doesn't auto-fix).
- **Migration drift**: 367 entries / 21 tables (PR #91 drives cleanup; low urgency now that startup self-heals).

## 2. Engineering approach: AST/KG-driven self-iteration

Generalize the `migration_drift_fix` pattern (detect→TODO→fix→verify→merge) from DB drift to **all structural debt**. Two layers:

### 2.1 Detectors (AST via los-ast + KG via codebase-memory)
los-ast has a rule-pack mechanism (`packages/rules`, `docs/rules`) + `docs/governance/module-topology.md`. The KG (codebase-memory, 6167 nodes) already indexes Function properties (`is_entry_point`, `is_exported`, `is_test`, `complexity`, `transitive_loop_depth`, `linear_scan_in_loop`, `unguarded_recursion`).

| Detector | Source | Finding | Fixer |
|---|---|---|---|
| migration_drift | drift gate (exists) | mig vs ensure schema diff | rewrite migration (Claude) — **PR #91, live** |
| unwired_function | KG: in-degree 0, not entry/export/test | function defined, never called | wire to entrypoint or remove (Claude) |
| hotspot_loop | KG: transitive_loop_depth ≥ 3 / linear_scan_in_loop ≥ 1 | nested-loop / O(n²) hot path | refactor (extract, index) (Claude) |
| file_size | GA job file_size (exists) | >400 lines | extract submodule (los-ast AST rewrite) |
| two_source_truth | AST: SCHEMA const in TS + SQL migration | duplicated schema source | align / codegen (Claude) |
| executor_bootstrap | KG + topology | executor lacks migrate/ensureAllStores | wire bootstrap (Claude) |

### 2.2 Self-iteration loop (reusable)
```
GA Loop job (cadence) ──detector──▶ finding → TODO (dedupe per unit, priority)
                                        │
              Claude agent ◀────────────┘
                 │  /pr-self-merge: fix → verify (detector oracle) → merge
                 ▼
            next sweep archives TODO (resolve闭环)
```
- **Oracle-driven**: every detector is also the verifier (drift gate, KG re-query, tests). No oracle → no autonomous loop.
- **Baseline-protected**: grandfather existing debt, fail only on new (the drift-gate pattern).
- **Modular**: one unit (table/function/file) = one TODO = one PR.
- **Circuit breaker + CI gate + branch protection** = safety net.

### 2.3 Event-flow-walk roadmap (module by module)
Improve modules along the `runChat` event flow, each as a self-iteration cycle:
1. **executor** (startExecutor tld=9 + bootstrap gap) — **first** (dual issue, highest ROI).
2. **scheduler/scheduled-task-runner** (tld=7, core event flow).
3. **loop.runAgent** + setup/phases/tool-runner (the agent loop itself).
4. **memory** (compaction, retrieval, reflection).
5. **task-runs / run-specs / execution-store** (state machine).
6. **providers/responses** (tld=3, streaming parse).
7. **review-runner / self-check** (tld=5).

## 3. First step: executor (bootstrap gap + tld=9 hotspot)

The executor is the highest-priority module: it's both the topology blind spot (§1.3) and the worst structural hotspot (§1.5). Two-part fix:
1. **Bootstrap**: add `migrateDir` + `ensureAllStores` (or a subset the executor uses) to `startExecutor`, so remote executor nodes get full schema at startup — closes the topology gap, mirrors gateway.
2. **Hotspot**: refactor `startExecutor` (tld=9) — extract phases (config → db → stores → heartbeat → routes → connect) into named steps, reducing nested-loop degree.

Verify: executor restart on a fresh DB creates all expected tables; `transitive_loop_depth` drops; `pnpm check` + executor tests green; /pr-self-merge.

## 4. Open questions / decisions
- **Detector hosting**: KG queries run via codebase-memory MCP (external). For a GA Loop job to use KG, either (a) re-index on a schedule + query the local graph DB, or (b) the job reads a KG-exported findings file (like the drift baseline pattern). Recommend (b) — CI runs KG queries, commits findings, job reads them.
- **Autonomy level**: detection-driven (Claude fixes) is the proven-safe baseline (PR #91). Fully-autonomous autoFix (los agent via deepseek-v4-pro) is Phase C, gated on firing-range validation.
- **AST rule packs**: los-ast rule-pack format + how to add a new rule — needs a read of `docs/rules` before building the first detector.
