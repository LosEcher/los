---
date: 2026-06-07
change: run-eval-comparison
surface: verification, cli, docs
impact: Run eval metrics can now compare baseline and candidate time windows for release before/after quality checks.
---

## Evidence

- Source: `packages/agent/src/run-evals.ts` adds `compareRunEvals`, reusing the
  independent `run_evals` quality table.
- API: `GET /run-evals/compare` accepts baseline and candidate time windows and
  returns both summaries plus deltas for count, success rate, failure count,
  average latency, retry count, tool errors, and model cost.
- CLI: `los evals compare --baseline-from ... --baseline-to ...
  --candidate-from ... --candidate-to ...` exposes the same comparison.
- Validation: `packages/agent/src/run-evals.test.ts` and
  `packages/gateway/src/run-evals-routes.test.ts`.
- Remaining risk: UI dashboards remain future work. Failover-scope metrics
  separating service and executor failures were added in the follow-up
  failover-scope-metrics fragment.

## Notes

This comparison is read-only. It does not turn eval results into runtime replay
evidence, provider compatibility evidence, or external summaries.
