# CI Observability Operations

Operational surface for Forgejo CI observability and alerting. Data sources:
the Forgejo REST API (`100.68.106.96:3022`, token in `.env`) and job logs.
The Forgejo job-log API returns stale bodies (2026-08-09 PR #256, reproduced
2026-08-16 on run 640), so self-reported summaries and run-level metrics are
the reliable channels.

## Tools

| Tool | Purpose | Data |
|---|---|---|
| `tools/ci-status-report.sh` | recent run report + **appends run metrics to JSONL** | wall + per-job minutes/status per run |
| `tools/ci-status-report.sh --trend 30` | trend/regression view from JSONL (no API) | median/mean wall, job failure rates, anomalies |
| `tools/ci-health-check.sh` | stuck/queued/failing watchdog, exit 0/1 | recent runs + non-terminal tasks |
| `tools/ci-gate.sh` | gate phases; writes `/tmp/los-gate-summary.json` | per-phase elapsed seconds |
| `tools/check-known-failures.sh` | NEW vs KNOWN test failure classification | baseline-driven |
| `tools/observe-pnpm-store.sh` | pnpm store capacity on the runner | store KiB + filesystem |

## Metrics persistence (A1)

`ci-status-report.sh` appends one JSON line per run to
`.los-runtime/ci-metrics/runs.jsonl` (gitignored; `LOS_CI_METRICS_FILE`
overrides the path). Each row:

```json
{"ts":"2026-08-16T23:26:54+08:00","ts_epoch":1786893696,"run_number":640,
 "event":"pull_request","title":"...","wall_min":6.93,
 "jobs":{"gate-fast":{"min":3.63,"status":"success"}, "...": {...}}}
```

Trend view:

```bash
source .env
bash tools/ci-status-report.sh --trend 30
# wall (min): median=6.5 mean=6.3 min=5.2 max=7.1
# job (median min / failure rate): gate-test 4.8m fail 17% ...
```

Baseline drift is now visible: the static 08-09 baseline comment in
`ci-status-report.sh` (wall 3.6–6.0m) vs measured median 6.5m on 08-16.

## Alerting (A3)

`ci-health-check.sh` exits 1 on: finished run wall > 15m (default), a
non-terminal task open > 30m, or — with `--include-failures` — a failure in
the last 5 finished runs.

Suggested cron (every 30 minutes):

```cron
*/30 * * * * cd /Users/echerlos/projects/los-workspace/projects/los && \
  bash tools/ci-health-check.sh --include-failures \
  >/tmp/ci-health.log 2>&1 || /path/to/alert-hook.sh
```

`alert-hook.sh` receives newline-structured anomalies on stdin. Wire it to a
wechat/telegram bot or the los governance IM channel; no alert channel is
implemented in the script itself (keep it dependency-free).

## Step-level timing self-report (A2)

Forgejo logs cannot be trusted for step timing, so jobs self-report:

- `gate-fast` runs `ci-gate.sh`, which writes `/tmp/los-gate-summary.json`
  (per-phase elapsed_sec) and the workflow echoes it in the
  `Emit gate summary (gate-fast)` step.
- `gate-test` appends `agent-groups/packages/coverage elapsed_sec` lines to
  `/tmp/los-ci-logs/timings.txt` and echoes them in
  `Emit test timings summary (gate-test)`.

GitHub mirrors the gate-fast summary into `GITHUB_STEP_SUMMARY`; GitHub job
timing is available natively through the API, so no echo channel is needed
there.

## B1 verification checklist (Forgejo turbo cache)

`.forgejo/workflows/ci.yml` sets `TURBO_CACHE_DIR: /root/.local/share/turbo`
on `gate-fast` and `gate-test`, relying on the runner-host volume mapping that
already persists `~/.local/share/pnpm/store` (run 137). On the next real PR
check:

1. gate-fast wall drops from ~2.7–4.2m toward ~2m on the second run after this
   change (first run warms the cache).
2. `pnpm run gate` inside the job prints turbo cache hits (`cache hit` lines).
3. If the directory is **not** persisted (cache never warms), the runner's
   volume mapping must be extended to `/root/.local/share/turbo`, or an
   `actions/cache` step with a Forgejo cache server is required instead.

## Runner health history (context)

Forgejo runs 3–619 (2026-07-mid → 2026-08-13) had 24–48h walls as the norm
(shared runner queueing). Run 620+ (2026-08-16) dropped to 5–7m after the
Windows burst-runner, pnpm-store persistence, and cache-enable changes
(Forgejo runs 130–140, 218–234). Treat pre-620 history as infrastructure-era
data, not alerting targets — `ci-health-check.sh` only evaluates the most
recent 5 finished runs for this reason.
