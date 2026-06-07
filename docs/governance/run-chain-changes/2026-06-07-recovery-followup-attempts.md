---
date: 2026-06-07
change: recovery-followup-attempts
commit: 60dd07a8
surface: scheduler, recovery
impact: Scheduler graph execution now turns retryable or resumable tool recovery decisions into follow-up task attempts when task retry capacity remains.
---

## Evidence

- Source: `packages/agent/src/scheduler.ts` evaluates task-run recovery after
  a graph task returns, marks retryable tool states as `retrying`, records the
  current task attempt as failed with recovery evidence, and requeues the task
  for the next graph attempt.
- Validation: `pnpm --filter @los/agent test`.
- Follow-up update: cancel and operator-attention recommendations now have
  explicit API/CLI transition commands in
  `2026-06-07-recovery-transition-commands.md`. The scheduler still does not
  automatically execute those terminal/operator decisions.

## Notes

This change consumes retry/resume decisions only while the agent task has
remaining `maxAttempts`. Exhausted tasks still settle through the existing
run-level recovery block.
