---
date: 2026-06-07
change: run-eval-summary
surface: verification, cli, docs
impact: Run eval records can now be summarized into failure-cause and quality metric groups without changing runtime replay evidence.
---

## Evidence

- Source: `packages/agent/src/run-evals.ts` adds `summarizeRunEvals` over the
  independent `run_evals` table.
- API: `GET /run-evals/summary` returns totals, success rate, average latency,
  retry/tool-error/model-cost totals, failure-class groups,
  verification-status groups, and provider/model groups.
- CLI: `los evals summary` exposes the same query surface with optional time
  window filters.
- Validation: `packages/agent/src/run-evals.test.ts` and
  `packages/gateway/src/run-evals-routes.test.ts`.
- Remaining risk: first-class release before/after comparison, UI dashboards,
  and failover-specific metrics remain future work.

## Notes

This is a read-only quality summary surface. It does not promote eval summaries
into `session_events`, `task_runs`, provider compatibility evidence, or external
summary evidence.
