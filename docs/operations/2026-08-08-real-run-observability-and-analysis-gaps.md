# Real-run observability & analysis gaps — 2026-08-08

> Status: **active roadmap**. Analysis grounded in live local DB (`55432/los`)
> and source. Pairwise is a **promotion gate**, not the daily observation surface.

## 1. Design position (correct reading)

Execution Lab is layered; dedicated comparison is the **exit**, not the entry:

```text
Real execution evidence (every run)
  → P0 observability projection (fingerprint / waterfall / failure facets)
  → Daily aggregation (quality, cost, failure trends)
  → Optional: execution experiment (change one variable)
  → Optional: pairwise + sample gate (promotion evidence)
  → Advisory optimization analysis
```

| Question | Primary surface | Needs pairwise? |
| --- | --- | --- |
| Why was this chat slow / blocked? | Session observability | No |
| Did provider quality regress this week? | Full-run evals + time-window compare | No |
| Can Pi kernel replace LOS default? | Experiment + pairwise + sample gate | Yes |
| May we change production defaults? | Gate-passed advisory only | Yes (as gate) |

## 2. Live inventory (2026-08-08 local)

| Surface | Count / status | Note |
| --- | --- | --- |
| `session_events` | ~440k | Strong fact base |
| `provider_call_telemetry` | ~1.9k (7d ~1.2k) | Call-level cost/latency present |
| `daily_agent_quality_snapshots` | 156 | Ops snapshots |
| `run_evals` single | 212 | Mostly scenario-economics / failover / backlog |
| Recent 14d `run_specs` | 52 | Real traffic exists |
| Recent 14d runs **with** `run_evals` | **8** | Very low auto-coverage |
| `run_evals` pairwise | **0** | Empty is expected without ingest |
| `execution_experiments` | 2 (both blocked) | K4 leftovers; not daily path |
| Web consumer of `/sessions/:id/execution-observability` | **none** (pre Phase 1) | Backend ready, UI gap |

Sample real chat session projection:

- Waterfall + tokens computable
- Fingerprint components often `unknown` (version events not written on chat path)

## 3. Gap list (ordered for real-run analysis)

| ID | Gap | Impact |
| --- | --- | --- |
| **G1** | Execution observability not on Sessions/Chat | Operators cannot answer “how did this run go?” without raw events |
| **G2** | Run terminal does not auto-write `run_evals` single | `#evals` is not a fleet quality ledger |
| **G3** | Fingerprint often unknown on real chat | Cohort / config-diff aggregation weak |
| **G4** | No failure-facet fleet filter | Blocked reasons stay one-off |
| **G5** | Aggregation pages fed by partial evals | Trends under-count real traffic |
| **G6** | Experiment/pairwise treated as entry | Wrong mental model; empty pairwise confuses |
| **G7** | Telemetry not rolled into run narrative | Cost/latency exist but not decision copy |
| **G8** | UI blurs observe vs promote | Ops nav puts Evals / Pairwise side by side |

## 4. Phased plan

### Phase 1 — See real runs (this batch) ✅ landed 2026-08-08

- Document this analysis (this file).
- Wire `GET /sessions/:id/execution-observability` into **Sessions** inspector and **Chat** run-evidence panel.
- Show fingerprint status, turn waterfall (model/tool wait, tokens, retries/errors/denied), failure facets.
- No contract change; no pairwise sample production; no auto `run_evals` yet.

**Evidence**

- `packages/web/src/pages/execution-observability-panel.tsx`
- Sessions: `packages/web/src/pages/sessions-page.tsx`
- Chat: `packages/web/src/chat-page.tsx` (+ invalidate in `useChatRun.ts`)
- Types: `packages/web/src/api/types-sessions.ts`
- Check: `packages/web/src/pages/execution-observability-panel.test.mjs`

**Acceptance**

- Selecting any session with events shows the projection without leaving Sessions/Chat.
- Empty facets / unknown fingerprint are explicit, not silent.
- Focused web check + boundary assertion for the new surface.

### Phase 2 — Auto quality ledger (single evals) ✅ landed 2026-08-08

- On `run_spec` terminal transition (`succeeded|failed|blocked|cancelled`), project a
  single `run_evals` row (`id = run-eval-terminal-<runSpecId>`, upsert).
- Metrics from `run_specs` + `session_events` + `verification_records`;
  `summary.kind = terminal_projection`.
- Best-effort only — projection failures never roll back AP1 transitions.
- Default fleet summary/compare **excludes** eval-backlog / provider=backlog /
  `eval_backlog_snapshot` unless `includeNoise=true` (UI checkbox on `#evals`).

**Evidence**

- `packages/agent/src/run-evals/terminal-projection.ts`
- Hook: `packages/agent/src/execution-store.ts` after terminal `run_spec` transition
- Filters: `packages/agent/src/run-evals.ts` + gateway `parseRunEvalQuery`
- UI: `packages/web/src/evals-page.tsx` (`includeNoise`)
- Tests: `packages/agent/src/run-evals-terminal-projection.test.ts`

**Note / Phase 2.1 backfill (executed 2026-08-08 local):**

```bash
pnpm run restart
./packages/gateway/node_modules/.bin/tsx tools/backfill-terminal-run-evals.mts --days 365 --limit 500
```

Live result on `55432/los`: **112/112** terminal runs have `terminal_projection`
evals. Fleet summary (noise excluded) count=304; with noise=324. Latency is
clamped to PostgreSQL INTEGER max for long-lived sessions.

### Phase 3 — Fleet aggregation

- By day / provider / failure facet / toolMode.
- Time-window compare on full single-eval feed.
- Facet → run list → observability drill-down.

### Phase 4 — Comparison remains the exit

- “Open experiment from this run” only when changing a variable for promotion.
- Pairwise + sample gate stay operator-gated; never the daily empty-state destination.

## 5. Non-goals (this batch)

- Ingesting historical K4 pairs for demo.
- Sample-gate UI.
- Changing AP1/AP2/AP3 or auto-promoting providers.
- Making Langfuse / external traces source of truth.

## 6. Related surfaces

- Backend projection: `packages/agent/src/execution-observability.ts`
- API: `GET /sessions/:id/execution-observability` (`trace-routes.ts`)
- Legacy counts API (kept): `GET /sessions/:id/observability`
- Research: `docs/research/2026-07-16-llm-space-observability-and-execution-optimization.md`
- Pairwise gate (exit only): `docs/operations/2026-08-04-sample-gate-ingestion.md`
