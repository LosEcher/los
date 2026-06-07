---
date: 2026-06-07
change: dag-verifier-runner
commit: d5811901
surface: scheduler, verification
impact: Scheduler DAG verifier tasks now execute required verification records and use failed verifier checks to block graph completion.
---

## Evidence

- Source: `packages/agent/src/scheduler.ts` runs verifier tasks through
  `runVerificationRecordsForRunSpec`, while
  `packages/agent/src/agent-task-graph-read-model.ts` treats failed verifier
  tasks as blocked completion rather than ordinary terminal failure.
- Validation: `pnpm --filter @los/agent test`.
- Remaining risk: verifier tasks execute required checks, but recovery
  decisions still do not create automatic retry/resume/cancel follow-up
  attempts.

## Notes

Verifier task attempts link back to the verification record used as evidence.
The scheduler still claims graph tasks conservatively and serially.
