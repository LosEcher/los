---
date: 2026-06-19
change: feat-runtime-hardening-tool-events
commit: pending
surface: chat | scheduler | docs
impact: Gateway chat now has explicit body/rate limits and security headers; tool execution can batch future opt-in parallelizable tools while preserving result order.
---

## Evidence

- Source:
  - `packages/gateway/src/chat-route.ts`
  - `packages/gateway/src/rate-limit.ts`
  - `packages/gateway/src/security-headers.ts`
  - `packages/gateway/src/routes/tools/artifact-routes.ts`
  - `packages/agent/src/loop/tool-runner.ts`
  - `packages/agent/src/session-events.ts`
  - `packages/agent/src/tools/core/registry-policy.ts`
- Validation:
  - `pnpm --filter @los/agent test -- --test-name-pattern "tool|session event|registry|loop"` — 292 passed.
  - Focused gateway route tests are required before merge.
  - `pnpm run gate` is required before push/merge because this changes gateway and agent runtime behavior.
- Remaining risk:
  - No built-in tool currently opts into `parallelizable`; the batching path needs a focused behavior test before enabling parallel execution for real tools.
  - `appendSessionEvents()` now batches inserts and sends aggregate notifications; live SSE consumers should treat batch notifications as invalidation signals and reload events by cursor.

## Notes

This fragment is required because the change touches `/chat`, `session_events`,
tool execution, and gateway runtime boundaries.
