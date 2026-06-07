---
date: 2026-06-07
change: external-summary-ingestion
surface: external summaries, gateway, CLI, governance
impact: Redacted external tool summaries can now be imported into a dedicated external_summary table without becoming runtime replay evidence.
---

## Evidence

- ADR: `docs/adr/0019-external-summary-ingestion-contract.md`.
- Source: `packages/agent/src/external-tool-summary.ts` owns normalization,
  redaction, raw-field rejection, and the `external_tool_summaries` store.
- Gateway: `POST /external-summaries` imports bounded summaries and
  `GET /external-summaries` lists them.
- CLI: `los external-summaries import --file summary.json` and
  `los external-summaries list`.
- Validation: `pnpm --filter @los/agent test`,
  `pnpm --filter @los/gateway test`, and `pnpm check`.

## Notes

Imported records remain `external_summary`. They do not write to
`session_events`, `task_runs`, `run_specs`, `verification_records`, or provider
compatibility evidence.
