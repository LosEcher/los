# Scheduled execution vs daily summary — 2026-08-09

> Status: **implemented** (read path). Grounded in local DB `55432/los`.
> Surfaces: `GET /ops/daily-digest`, `los digest`, `#usage` digest panel.

## Question

Do current scheduled-task runs produce an operator-readable daily summary?
Should we add a daily execution digest?

## Live inventory `[E]`

### Scheduled work (24h sample)

| Schedule | Cadence | 24h outcome |
| --- | --- | --- |
| dogfood runtime readiness check | 5m interval | 288 succeeded |
| observability: gateway/executor log freshness (V3) | 10m | 144 succeeded |
| NAS34 drift check | 6h | 4 cancelled |
| surge log error analysis v4 | 6h | 4 cancelled |
| network-observe daily trend analysis v5 | cron 09:00 Asia/Shanghai | 2 cancelled |

Template mix (all schedules): `scheduled_execution` 21, `runtime_readiness` 3,
`morning_inbox_digest` 2, `scheduled_feed_analysis` 1.

7d run totals: succeeded 1690 / skipped 68 / cancelled 18 / failed 16 /
awaiting_approval 1. Mean success duration ~0.7s (mostly readiness probes).

### Existing “daily” surfaces

| Surface | What it covers | Gap for “execution digest” |
| --- | --- | --- |
| `daily_agent_quality_snapshots` | Per project: inbox aging, schedule counts, recovery, verification, **run_evals** provider quality | modelCost often 0; not a narrative digest; not WeChat-push by default |
| `morning_inbox_digest` template | Inbox-oriented morning rollup (audit mode) | Not wired as a full fleet execution report |
| `#usage` / `GET /usage/summary` (new) | L1 tokens/cost/cache by provider/model/day | No schedule dimension yet |
| Governance sweep digests | GA job progress → WeChat | Ops health, not task execution summary |
| Feed analysis schedules | Domain analysis jobs | Product analysis, not meta-ops digest |

## Reading

1. **Schedules are running** and mostly health probes, not “analysis report”
   generators. High succeeded counts are dogfood/readiness ticks.
2. **Analysis-style schedules** (network-observe, surge log, NAS drift) show
   cancellations in the last 24h — not producing reliable daily reports.
3. **Daily Agent Quality** already aggregates schedule *metrics* into snapshots
   but is an ops dashboard series, not a single “yesterday’s executions” story.
4. **Usage Hub L1** answers cost/token questions for model calls; it does not
   yet join `scheduled_work_item_runs` → `task_runs` / `session_events`.

## Recommendation (next design slice)

Add a **Daily Execution Digest** as a read-only L1 projection (not a new agent
loop), composed of:

1. **Schedule slice** — enabled schedules, 24h run counts by status, top
   failures + last resultSummary reason.
2. **Usage slice** — reuse `/usage/summary?from=yesterday` totals + top models.
3. **Quality slice** — latest `daily_agent_quality` schedule + provider rows
   for the default project.
4. **Delivery** — optional: `morning_inbox_digest`-style schedule template or
   WeChat push via existing governance notify path; UI tab under `#usage` or
   Schedules.

### Non-goals

- Do not invent a second ledger.
- Do not mix external CLI fleets into the digest (keep evidenceClass labels).
- Do not auto-mark analysis schedules healthy from readiness probe success.

### Smallest ship path — landed

1. `GET /ops/daily-digest?day=YYYY-MM-DD` ✅
2. CLI `los digest [--day YYYY-MM-DD]` ✅
3. Web `#usage` digest + cadence table ✅
4. Schedule `templateId: daily_execution_digest` + WeChat via `ops.daily_digest` ✅ (2026-08-10)
5. Manual / backfill: `POST /ops/daily-digest/push` or `los digest --push --day YYYY-MM-DD` ✅

## Cadence recommendations (live heuristics)

| Schedule | Current | Recommendation | Why |
| --- | --- | --- | --- |
| dogfood runtime readiness | 5m (~288/day) | **15m** | Always succeeds in ~0.02s; dogfood does not need sub-5m |
| log freshness V3 | 10m (~144/day) | **30m** | Same; lag detection does not need 10m |
| network-observe v5 ×2 | daily 09:00 | **retire one duplicate** | Two enabled rows, same title |
| surge / NAS / network-observe | 6h / daily | **fix preapproved_scope semantics** | Was waiting per-run then `approval_timeout` deny |

### Approval fix (landed 2026-08-09)

Root cause: `executeScheduledWorkRun` only treated `preapproved_scope` as auto for
`scheduled_feed_analysis`, so `scheduled_execution` still entered
`awaiting_approval` and cancelled after 30m with `deniedReason=approval_timeout`.

Code change (`packages/agent/src/scheduled-work/runner.ts`): **any**
`approvalPolicy === 'preapproved_scope'` skips the per-run wait.

Host config belt-and-suspenders: network-observe v5 / surge v4 / NAS34 set
`approvalTimeoutAction=approve`.

## Evidence commands

```bash
los digest
curl -H "x-los-auth-token: …" 'http://127.0.0.1:8080/ops/daily-digest'
curl -H "x-los-auth-token: …" http://127.0.0.1:8080/usage/summary
curl -H "x-los-auth-token: …" http://127.0.0.1:8080/daily-agent-quality/baseline?days=7
```
