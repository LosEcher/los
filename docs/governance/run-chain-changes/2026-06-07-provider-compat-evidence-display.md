---
date: 2026-06-07
change: provider-compat-evidence-display
commit: pending
surface: provider, web, cli
impact: Operators can inspect provider compatibility proof ids, task/run links, token usage, and redacted summary fields through API, CLI, and Web.
---

## Evidence

- Source: `packages/agent/src/provider-compat-evidence.ts`,
  `packages/gateway/src/server.ts`, `packages/cli/src/provider.ts`,
  `packages/web/src/pages.tsx`, and
  `contracts/provider-compat-evidence.yaml`.
- Validation: `pnpm --filter @los/agent test`,
  `pnpm --filter @los/gateway test`, `pnpm --filter @los/web test`,
  `pnpm --filter @los/web check`, `pnpm check`,
  `./tools/check-contracts.sh`, and `pnpm test`.
- Remaining risk: no live compat smoke has been recorded in this fragment yet.

## Notes

This change exposes existing provider compatibility evidence. It does not
promote advisory providers into required gates.
