---
change: provider-promote-setup-only
date: 2026-06-07
surface: provider, cli, governance
impact: `los provider promote` is explicitly setup-only; compatibility promotion evidence remains owned by `los compat --execute` and provider compatibility evidence records.
---

## Summary

- `los provider promote <name>` remains an interactive setup helper for blocked
  provider credentials.
- It does not persist required-gate promotion decisions and does not mutate
  compatibility policy.
- Verified advisory evidence continues to come from executed compatibility
  probes recorded in `provider_compat_evidence`.
- Required promotion/demotion should be a later policy command that updates
  ADR 0017, ADR 0014, compatibility targets, harness expectations, and
  operation evidence together.

## Validation

- `pnpm check`
- `pnpm test`

## Remaining Risk

The future required-target promotion/demotion command is not implemented in
this change.
