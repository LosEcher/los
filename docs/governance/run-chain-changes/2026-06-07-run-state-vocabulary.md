---
date: 2026-06-07
change: run-state-vocabulary
commit: pending
surface: web, cli, verification
impact: Operators can inspect a compact run phase, next action, and blocker projection without reading raw graph JSON.
---

## Evidence

- Source: `packages/agent/src/run-state-vocabulary.ts`,
  `packages/gateway/src/server.ts`, `packages/cli/src/index.ts`,
  `packages/web/src/pages.tsx`, and `contracts/run-stream.yaml`.
- Validation: `pnpm --filter @los/agent test`,
  `pnpm --filter @los/gateway test`, `pnpm --filter @los/web check`,
  `pnpm check`, `./tools/check-contracts.sh`, and `pnpm test`.
- Remaining risk: the projection is read-only and does not yet trigger
  scheduler retries or verifier DAG tasks.

## Notes

The projection reuses existing `run_specs`, `task_runs`, `tool_call_states`,
and `verification_records` truth. It deliberately does not add a new runtime
state table.
