---
change: provider-policy-decisions
date: 2026-06-07
surface: provider, cli, gateway, governance
impact: Proposed required-gate provider promotion/demotion decisions are now persisted separately from provider setup and compatibility evidence.
---

## Summary

- Source: `packages/agent/src/provider-promotion-decisions.ts` adds
  `provider_promotion_decisions`.
- API: `POST /providers/promotion-decisions` records proposed
  `promote_required` or `demote_advisory` decisions. `GET
  /providers/promotion-decisions` lists them.
- CLI: `los provider policy promote TARGET --evidence-id ID --reason TEXT`
  records proposed required promotion. `los provider policy demote TARGET
  --reason TEXT` records proposed demotion.
- Boundary: policy decisions do not mutate `DEFAULT_COMPATIBILITY_TARGETS` or
  enforce gates. Enforcement still requires ADR 0017, ADR 0014, compatibility
  targets, harness expectations, and operation evidence to change together.

## Validation

- `pnpm --filter @los/agent test`
- `pnpm --filter @los/gateway test`
- `pnpm check`
- `pnpm test`

## Remaining Risk

At this change point, enforced required-target promotion/demotion was still
separate work. Follow-up enforcement is recorded in
`docs/governance/run-chain-changes/2026-06-07-provider-policy-enforcement.md`.
Proposed records remain a policy decision ledger until explicitly marked
`enforced`.
