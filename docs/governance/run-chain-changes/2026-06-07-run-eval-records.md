---
date: 2026-06-07
change: run-eval-records
surface: verification, cli, docs
impact: Run quality metrics can now be recorded and queried without mixing them into runtime replay, external summaries, or provider compatibility evidence.
---

## Evidence

- Source: `packages/agent/src/run-evals.ts` adds the `run_evals` store with
  success, latency, retry count, tool error count, verification status, model
  cost, user feedback, failure class, and summary fields.
- API: `POST /run-evals` records one eval and `GET /run-evals` lists filtered
  eval records.
- CLI: `los evals record --run RUN_ID --success true|false` and
  `los evals list` expose the operator path.
- Validation: `packages/agent/src/run-evals.test.ts` and
  `packages/gateway/src/run-evals-routes.test.ts`.
- Remaining risk: release before/after quality comparison, failure dashboards,
  and failover-specific metrics remain future work.

## Notes

`run_evals` is a quality record surface. It does not write to
`session_events`, `task_runs`, `provider_compat_evidence`, or
`external_tool_summaries`.
