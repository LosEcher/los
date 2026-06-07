---
date: 2026-06-07
change: provider-policy-enforcement
surface: provider policy, compatibility harness, CLI, gateway
impact: Required-gate provider policy decisions now have an explicit enforced state that can affect default compatibility targets.
---

## Evidence

- Source: `packages/agent/src/provider-promotion-decisions.ts` can mark a
  proposed decision as `enforced`.
- Source: `packages/agent/src/compat-harness.ts` resolves default required
  compatibility targets from enforced promotion/demotion decisions.
- CLI: `los provider policy enforce <decision-id>` marks a policy decision
  enforced through the gateway.
- Gateway: `POST /providers/promotion-decisions/enforce` exposes the same
  transition.
- Validation: `pnpm --filter @los/agent test`,
  `pnpm --filter @los/gateway test`, and `pnpm check`.

## Notes

Proposed policy decisions still do not change gates. `los compat` reads the
enforced policy only when no explicit `--target` is supplied, so operator-chosen
advisory probes remain possible.
