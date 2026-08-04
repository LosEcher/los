# Daily-Use Gap Analysis — 2026-08-06 Recheck

## Background

Baseline: 2026-07-28 analyses (`los-daily-use-gap-analysis`,
`los-daily-agent-gap-analysis-2026-07-28` memory entries; 17-item gap list +
P0–P3 priority list). This recheck verifies each item against current
implementation (2026-08-06 `main`, after P1 closure 07-30 and event-storm
convergence 08-05). Every claim below cites code evidence gathered during this
recheck.

## Closed Since 07-28 (verified)

| 07-28 item | Current state | Evidence |
|---|---|---|
| P0 Docker one-click deploy | ✅ compose/Dockerfile/entrypoint complete (image publishing still open, see G3) | `docker-compose.yml:24-96`, `Dockerfile`, `docker-entrypoint.sh` |
| P0 Web login/auth | ✅ username/password + JWT + users table + operator/user roles | `auth-routes.ts:29-138`, `auth-store.ts:22,106`, `login-page.tsx` |
| P0 Onboarding wizard | ✅ 4-step Provider→Verify→Project→Chat, auto-redirect when no providers | `onboarding-page.tsx:64-164`, `App.tsx:195-209` |
| P0 Empty-state guides | ✅ all pages except Run Specs (plain text) | `skills/mcp/service/providers` pages empty-guide |
| P0-1 One-stop Web work item path | ✅ goal→plan→approve→execute→verify→diff→done closed loop | `work-page.tsx:202-212`, `action-capabilities.ts:29-67`, `work-guidance.tsx:12-49` |
| P0-2 Plan→Execution bridge | ✅ approve → `dispatchPersistedRunSpec(id,'execution')` | `run-routes.ts:304-348`, `run-resume-dispatch.ts:36-118`, `chat-plan-approval.tsx:22-71` |
| P1 Context fill monitor | ✅ promptTokens bug fixed, 3-tier thresholds | `context-monitor.ts`, loop.ts checkpoint 75%/critical 85% |
| P1 Stop-condition runtime enforcement | ✅ in-loop check every 5 rounds + independent goal-self-check judge gate | `loop.ts:482-504`, `stop-conditions.ts`, `goal-self-check-runner.ts:160-247` |
| P1 Scheduled autonomy loop | ✅ scheduled-work + circuit breaker + retry + outcome writeback | `scheduled-work/runner.ts:110-137`, `store.ts:224-326` |
| P1 Smart provider routing | ✅ health-aware preferredInitialTarget | P1-15 (07-30) |
| P1 Subagent lineage | 🟡 partial: background spawn/query/kill + persisted child run_spec, but results memory-only (G2) | `agent-tools.ts:273-371` |
| P2 MCP HTTP/SSE transport | ✅ stdio/sse/streamable-http accepted | `mcp-routes.ts:259-293` |
| P2 External channels | ✅ telegram-bot + wechat-bot complete | `telegram-bot/src/index.ts`, `wechat-bot/src/index.ts` |
| P2 Scheduler feedback loop | ✅ outcome ledger + circuit breaker + auto/manual retry | `scheduler-decision-ledger.ts:193-211`, `store.ts:310-326` |
| P2 Multi-agent graph | 🟡 baseline (2-4 workers + verifier + Web control page); provenance display/recovery evidence/serial-vs-graph eval open | `agent-graph-control.tsx`, roadmap Stage E |
| P3 Multi-user permissions | ✅ operator/user two-tier (basic) | `auth-store.ts:22`, `operator-gate.test.ts` |

## Remaining Gaps (2026-08-06)

### Tier 1 — Reliability / Trust (prerequisite for daily use)

| ID | Gap | Evidence | Risk |
|---|---|---|---|
| G1 | ~~Real interrupted-run recovery never exercised end-to-end~~ ✅ **closed 2026-08-03** | kill gateway → restart → resume same run frozen as smoke: `tools/smoke-interrupted-run-recovery.sh` (`--scenario auto` proves `recoverApprovedRunDispatches` auto-resume; `--scenario in-flight` proves lease fence + operator revise/approve/verify resume). Evidence: `docs/operations/2026-08-03-interrupted-run-recovery-smoke.md` | user cannot trust work survives a crash |
| G2 | ~~Subagent background results memory-only; no persisted completion + resume~~ ✅ **closed 2026-08-06** | `run_specs.result_json` column + `updateRunSpecResult()`; background completion/failure persists to child run_spec; `query_agent`/`list_agents` recover from DB after restart (tenant/project scoped), `unknown` status when run spec exists without result. Tests: `subagent-persistence.test.ts` (isolatedGroupB), run-specs.test.ts | — |
| G3 | ~~Docker image publishing absent while README/compose advertise `ghcr.io/...`~~ ✅ **closed 2026-08-04** | identity fixed to `ghcr.io/losecher/los` (GHCR lowercases username; `los-ecommerce` org never existed) in `docker-bake.hcl`/`Dockerfile`/`docker-compose.yml`; Dockerfile pnpm aligned 9.0.0→11.6.0; publish job `.github/workflows/docker-publish.yml` (main push path-filtered + manual dispatch, buildx bake linux/amd64+arm64, `latest` + `sha-<commit>`). First publish verified: `ghcr.io/v2/losecher/los/tags/list` shows both tags, index 200 with amd64+arm64 manifests. Why GitHub Actions not Forgejo: only active Forgejo runner is Windows/podman (no reliable multi-platform linux builds), GHCR auth free via GITHUB_TOKEN, image identity is GitHub-native | — |
| G4 | ~~scheduled-work `half_open` circuit state never written by any code path~~ ✅ **closed 2026-08-06** | `recoverOpenScheduledWorkCircuits()` auto-recovers open circuits to `half_open` after the 24h window (`policy.ts` `CIRCUIT_RECOVERY_WINDOW_MS`); `recordScheduledRunOutcome()` closes the circuit on a successful probe and re-opens + restarts the window on a failed probe without a second recovery item. Tests: `scheduled-work.test.ts` (half_open probe success/failure paths) |

### Tier 2 — Experience (daily willingness)

| ID | Gap | Evidence |
|---|---|---|
| G5 | ~~No Chinese i18n at all~~ ✅ **closed 2026-08-06** | i18n infrastructure (`packages/web/src/i18n/`: `I18nProvider` + `useI18n()`/`tt()`, `localStorage` persistence `los.lang`, `document.documentElement.lang`, browser-language first-visit default) + full en/zh dictionaries (8 files, ~1,600 keys across `core/chat/work/pages/ops/assets` areas) + EN/中文 switcher in the topbar + localized `formatDate`/`formatDuration`. All 43 UI surfaces extracted; `aria-label`/`title`/placeholder translated. Tests: `i18n.test.mjs` (en/zh key parity, static call-site resolution, placeholder subset rule), `ui-boundary.test.mjs` adapted to assert against the en dict, e2e `i18n-switcher.spec.ts` (switch + persistence on desktop & mobile). Checks: `pnpm --filter @los/web check` + 28 unit + 22 e2e green |
| G6 | Context compaction: text-level only, no masking cascade | `loop/compression.ts` (heuristic summary + tail truncation + hard trim); persistent compaction is structured DB archive (`memory/src/core/compaction.ts`) but that is not context masking |
| G7 | CLI still static render* output, no typed projection / interactive terminal | `cli/src/run-operations.ts:39-73`, `artifacts.ts` |
| G8 | Web diff review is "viewer"-level only | `work-review-panel.tsx:7-112` (line coloring, truncation; no side-by-side/inline comments) |
| G9 | Mobile: basic responsive only | `styles.css` @media ≤780px collapses sidebar; no standalone app/push |

### Tier 3 — Ecosystem / Scale

| ID | Gap | Evidence |
|---|---|---|
| G10 | Provider/tool hot reload (ADR 0033) not implemented | ADR status Proposed; no watcher/version counters anywhere |
| G11 | Auto-update not implemented (deliberate: manual rollout documented) | `2026-08-03-node-inventory.md:139`; `executor/src/maintenance.ts:86-97` rollout state machine only |
| G12 | No npm publishing (all 11 packages `private` 0.1.0) | `packages/*/package.json` |
| G13 | Eval corpus automation lags (E01–E24 documented; automated probes concentrated on early IDs) | `docs/governance/eval-backlog.md` |
| G14 | Rejected/long-term: ACP (intentional, los-mcp is sole programmatic interface), TUI, OAuth/SSO, portable handoff, IDE plugin, plugin market | `programmatic-interface-boundary.test.ts:16-18` |

## Document Drift Note

`docs/governance/agent-workflow-roadmap.md` Stage B/F is stale vs implementation:
stop-condition enforcement (Stage B remaining gap #8) is now implemented
(`loop.ts:482-504`); K4/Pi section ends at 2026-07-22 state. Next governance
cycle should reconcile roadmap with code.

## Suggested Order

1. **Tier 1 first**: ~~G2 persist subagent results to run_spec~~ ✅ done
   2026-08-06; ~~G1 interrupted-recovery drill (kill gateway → restart → resume
   same run, freeze as smoke)~~ ✅ done 2026-08-03
   (`docs/operations/2026-08-03-interrupted-run-recovery-smoke.md`); ~~G4
   half_open recovery path~~ ✅ done 2026-08-06.
2. **Tier 2**: ~~G5 Chinese i18n~~ ✅ done 2026-08-06 (full en/zh extraction,
   topbar EN/中文 switcher, persistence, `i18n.test.mjs` parity + e2e switcher
   spec); G7 CLI projection; G8 diff review upgrade.
3. **Tier 3**: G3 fix bake identity + add image build/push CI, or stop
   advertising GHCR; G12 npm publish under `@los/` scope.
