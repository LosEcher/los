# Usage Hub design — 2026-08-09

> Status: **active**. P0 implemented (L1 summary). L2/L3 deferred.

## Problem

Operators need cost/token visibility across agents and models. Peers solve
adjacent problems:

| Tool | Problem |
| --- | --- |
| [ccglass](https://github.com/jianshuo/ccglass) | Live wire inspect via local proxy |
| [ccusage](https://github.com/ccusage/ccusage) | Post-hoc multi-CLI local history cost |
| T3 Code usage | Product page over Claude/Codex machine history |

los already owns a dual ledger (`session_events` + `task_runs` + telemetry).
Mixing external CLI history into runtime evidence would break ADR 0019 and AP3.

## Three evidence layers

| Layer | Class | Source | Use |
| --- | --- | --- | --- |
| L1 | `los_runtime` | session_events / telemetry / run_evals | Authoritative cost & quality |
| L2 | `wire_inspect` | optional operator capture | Debug prompt/cache/tools |
| L3 | `external_usage` | ccusage import / local JSONL | Fleet overview only |

Hard rules:

1. Promotion and eval gates use **L1 only**.
2. L3 never writes `session_events` replay material.
3. UI always labels the evidence class.

## P0 (this batch)

1. Write `usage` onto `provider_call_telemetry` success paths (stream + non-stream).
2. `GET /usage/summary` contract + aggregation from `model.response` events.
3. Web `#usage` overview + `los usage` CLI.
4. Observe live totals vs raw SQL.

## P1 (when needed)

- Stronger channel / agent-identity dimensions once events carry them.
- Cache-hit trend cards on the Usage page.

## P2 / P3 (later)

- L3: import `ccusage --json` into a separate table.
- L2: operator wire glass for los HTTP only (do not fork ccglass).

## Surfaces

- Contract: `contracts/usage-summary.yaml`
- Logic: `packages/agent/src/usage-summary.ts`
- Route: `GET /usage/summary`
- CLI: `los usage`
- Web: `#usage`
