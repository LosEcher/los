---
date: 2026-07-19
change: active-session-failover-and-pairwise-ui
surface: agent, gateway, web, operations
impact: Active gateway-owned task attempts can be fenced and claimed after heartbeat loss; pairwise evidence has a dedicated filtered console page.
---

## Evidence

- `packages/agent/src/task-runs/recovery.ts` fences active task attempts with
  gateway and lease-version conditions before recording failure evidence.
- `packages/gateway/src/chat-session-helpers.ts` uses that recovery from the
  existing orphan reaper, then claims the run spec for the healthy gateway.
- `packages/gateway/src/active-session-failover.test.ts` is the repeatable
  long-session regression harness; it verifies persisted stream evidence and
  rejects stale-owner completion.
- `GET /run-evals/pairwise` supports pair, experiment, verdict, and bounded
  limit filters. `packages/web/src/pairwise-evals-page.tsx` renders baseline,
  candidate, verdict, human, judge, deterministic, rubric, and timestamp
  columns, with operator-gated recording.
- `packages/web/e2e/pairwise.spec.ts` covers page load, filters, separated
  evidence columns, and the 403 operator path.

## Checks

- `pnpm --filter @los/agent check`
- `pnpm --filter @los/gateway check`
- `pnpm --filter @los/web check`
- `pnpm --filter @los/gateway test -- src/active-session-failover.test.ts`
- `pnpm --filter @los/web exec playwright test e2e/pairwise.spec.ts --project=desktop-chromium`
- `./tools/check-structure.sh`
