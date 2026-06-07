---
date: 2026-06-07
change: failover-eval-auto-recording
surface: recovery, scheduler, run-evals
impact: The scheduler now auto-records a failover eval with failoverScope='executor' when an executor task fails, separating executor failures from service failures in the metrics surface.
---

## Evidence

- Source: `packages/agent/src/run-evals.ts` adds `recordFailoverEval`, a
  thin wrapper around `recordRunEval` that auto-generates id and summary with
  failover scope.
- Source: `packages/agent/src/scheduler.ts` calls `recordFailoverEval` in the
  `runScheduledAgentTask` catch block when an executor was used, recording
  `failureClass: 'executor_failure'` and `failoverScope: 'executor'`.
- Validation: `packages/agent/src/run-evals.test.ts` tests
  `recordFailoverEval` directly; `packages/agent/src/scheduler.test.ts`
  exercises the scheduler error path.
- Remaining risk: service-failover auto-recording from gateway-level errors
  (DB failures, upstream unavailability) remains explicit via `POST /run-evals`
  with `failoverScope: 'service'`.
