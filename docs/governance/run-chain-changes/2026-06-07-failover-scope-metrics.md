---
date: 2026-06-07
change: failover-scope-metrics
surface: verification, cli, docs
impact: Run eval metrics can now distinguish service failover from executor failover via a failover_scope dimension.
---

## Evidence

- Source: `packages/agent/src/run-evals.ts` adds `failover_scope` column to the
  `run_evals` table, `RecordRunEvalInput`, `ListRunEvalsOptions`,
  `SummarizeRunEvalsOptions`, plus a `byFailoverScope` summary grouping.
- API: `POST /run-evals` accepts `failoverScope` (`service` or `executor`);
  `GET /run-evals`, `GET /run-evals/summary`, and `GET /run-evals/compare`
  accept `failoverScope` as a filter and return `byFailoverScope` in summaries.
- CLI: `los evals record --failover-scope service|executor`,
  `los evals list --failover-scope service|executor`,
  `los evals summary` renders the new `failover_scope` grouping.
- Validation: `packages/agent/src/run-evals.test.ts` and
  `packages/gateway/src/run-evals-routes.test.ts`.
- Remaining risk: UI dashboards remain future work.

## Notes

The `failover_scope` dimension is a narrow, explicit field (not derived from
`failure_class`) so that service and executor metrics stay independent of
failure classification. Records with no explicit scope default to
`unspecified` in the summary grouping.
