---
date: 2026-06-07
change: feat/agent-enhancements
commit: 4c5cff17
surface: web
impact: Web console run-inspection surfaces were expanded while keeping `los`
  runtime evidence in `task_runs`, `session_events`, and related agent/gateway
  records.
---

## Evidence

- Source: `jj log` shows `feat/agent-enhancements` and `main` at
  `4c5cff17 docs: add Hermes Web UI reference plan` after the 2026-06-07
  merge.
- Source: the change stack includes session management, event timeline,
  Providers/Nodes/Settings alignment, node command history, event details, UI
  polish, and chat route/page splitting.
- Validation: `./tools/check-contracts.sh`, `pnpm check`, and `pnpm test`
  passed before `main` was moved to `4c5cff17`.

## Notes

This fragment records the merged local enhancement stack as the initial
run-chain reference point. It does not assert new runtime replay semantics.
Future changes that alter `/chat`, scheduler recovery, executor dispatch,
provider gates, verification records, or run-inspection UI should add their own
fragment here.
