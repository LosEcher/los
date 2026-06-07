---
date: 2026-06-07
change: memory-compaction-pipeline
surface: memory, gateway, cli
impact: Initial memory compaction pipeline per ADR 0020 — compactSession aggregates session observations, task runs, and eval records into structured summaries with failover pattern detection and procedural candidates (stored for review, never auto-promoted).
---

## Evidence

- Source: `packages/memory/src/compaction.ts` adds `compactSession`,
  `getCompaction`, `listCompactions`, `ensureMemoryCompactionStore` with a
  `memory_compactions` table.
- API: `POST /memory/compact` triggers compaction for a session.
  `GET /memory/compactions` lists compactions with session and run_spec filters.
- CLI: `los memory compact --session-id SID` and `los memory compactions`.
- Compaction gathers: observation count, task run count/statuses, eval record
  summaries, and detects executor failover patterns from `run_evals`.
- Procedural candidates are stored in `procedural_candidates_json` but are
  NEVER automatically promoted to rules — operator review is required per ADR.
- Validation: `packages/memory/src/compaction.test.ts` (2 tests),
  `pnpm check`, `./tools/check-contracts.sh`.
- Remaining risk: no self-compaction trigger (must be called explicitly), no
  cross-session pattern extraction, no promotion workflow UI.
