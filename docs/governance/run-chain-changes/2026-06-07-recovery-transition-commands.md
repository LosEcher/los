---
change: recovery-transition-commands
date: 2026-06-07
surface: recovery, gateway, cli
impact: Run recovery now has explicit cancel and operator-attention transition commands in addition to the read-only recovery decision surface.
---

## Summary

- Source: `packages/agent/src/tool-call-recovery.ts` now exposes
  `applyToolCallRecoveryTransitionForRunSpec`.
- API: `POST /runs/:id/recover` remains read-only by default. Passing
  `apply: true` with `intent: cancel` or `intent: operator-attention` applies a
  transition.
- CLI: `los run recover RUN_ID --apply --intent cancel` cancels active run
  recovery state; `--intent operator-attention` records an operator handoff.
- Evidence: cancel transitions mark active tool states skipped, active task
  runs cancelled, the run spec cancelled, and write `run.recovery_cancelled`.
  Operator-attention transitions mark the run spec blocked and write
  `run.operator_attention_required`.

## Validation

- `pnpm --filter @los/agent test`
- `pnpm --filter @los/gateway test`

## Remaining Risk

Provider promotion decisions, DAG parallel execution, editable-surface conflict
checks, UI read models, and external summary ingestion remain separate work.
