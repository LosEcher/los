---
date: 2026-06-07
change: run-verification-recovery
commit: 4f99ff2c
surface: chat, scheduler, cli, api, verification
impact: Operators can see direct chat verification blocking, release required checks through the verifier runner, inspect tool recovery decisions, and rely on scheduler graph completion to block when tool recovery is required.
---

## Evidence

- Source: `packages/gateway/src/chat-run-completion.ts`,
  `packages/gateway/src/server.ts`, `packages/cli/src/index.ts`,
  `packages/agent/src/verification-runner.ts`,
  `packages/agent/src/tool-call-recovery.ts`,
  `packages/agent/src/run-state-vocabulary.ts`, and
  `packages/agent/src/scheduler.ts`.
- Validation: `pnpm --filter @los/agent test`.
- Live smoke:
  `docs/operations/2026-06-07-run-verification-recovery-smoke.md`
  records direct `/chat` verification blocking, verifier-runner release,
  tool-state recovery decisions, and run-state vocabulary display.
- Remaining risk: recovery is wired into scheduler completion protection and
  operation surfaces, but it does not yet create an automatic retry/resume
  follow-up task attempt.

## Notes

The first live verifier command used `node` and failed because the gateway
runtime did not have the interactive-shell Node path. The successful release
smoke uses the absolute Node path to prove the verifier runner behavior without
depending on shell profile setup.
