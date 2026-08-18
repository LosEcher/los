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
on `gate-fast` (and `gate-test` as a no-op safeguard — that job's steps run
per-package node test runners, no turbo), relying on the runner-host volume
mapping that already persists `~/.local/share/pnpm/store` (run 137).

**Status (verified 2026-08-18):** gate-fast measured 2.2–2.8m across runs
646–657 after enablement (was 2.7–4.2m before), i.e. ~2m with a warm cache.
The `Cached:` line in the typecheck phase confirms hits. The directory is
persisted: the observe step below reports entries/size each run.

**Tuning (2026-08-18, `turbo.json`):**

1. `globalEnv` trimmed from `[DATABASE_URL, TEST_DATABASE_URL,
   LOS_ALLOW_LIVE_TEST_DB, LOS_TEST_RUN_ID, NODE_ENV]` to `[NODE_ENV]`.
   Build/check are `tsc`-only and never read the DB/test vars, and the `test`
   task is `cache: false`, so hashing them only created cache-key volatility
   (e.g. `LOS_TEST_RUN_ID` is a per-run UUID — any turbo invocation with it in
   the environment silently busts the whole cache family). Keep DB/test vars
   out of `globalEnv`; NODE_ENV stays because it can genuinely affect output
   (vite build mode).
2. `globalDependencies: ["tsconfig.base.json"]` added. Every package tsconfig
   extends the root base, but turbo's default global hash does not include it
   (`globalCacheInputs.files` was empty) — changing the base used to produce
   stale cache hits. This is a correctness fix, not just a speed one.
3. First run after either change is a full cache miss (global hash changed);
   the runner warms back up on the following runs.

**Machine-verified cache-hit signal (not manual):**

- `tools/ci-gate.sh` phase 1 folds the turbo run summary into the gate summary
  JSON: the emitted file gains `"turbo": {"cached", "total", "tasks",
  "cache_hits", "cache_misses"}` (parsed from the `Cached:`/`Tasks:` summary
  line plus per-task `cache hit`/`cache miss` lines). The workflow's
  `Emit gate summary (gate-fast)` step prints it every run.
- `tools/observe-turbo-cache.sh --json` (new step `Observe turbo cache
  capacity` in gate-fast) reports the persisted directory's entry count and
  size. Exit 2 if the directory is missing — a signal the runner volume
  mapping broke.

**If the cache is not hitting:**

1. Check the gate summary `turbo` block: `cached` ≈ 0 with `total` > 0 for
   several runs means the volume mapping broke — extend the runner's mapping
   to `/root/.local/share/turbo`, or add an `actions/cache` step with a
   Forgejo cache server instead.
2. Check `observe-turbo-cache.sh` output: `exists:false` means the same thing.
3. Structural changes (new package, lockfile bump, `turbo.json`/base-tsconfig
   edit) legitimately cold-miss once — look for the miss pattern across
   consecutive runs, not a single run.

## Runner health history (context)

Forgejo runs 3–619 (2026-07-mid → 2026-08-13) had 24–48h walls as the norm
(shared runner queueing). Run 620+ (2026-08-16) dropped to 5–7m after the
Windows burst-runner, pnpm-store persistence, and cache-enable changes
(Forgejo runs 130–140, 218–234). Treat pre-620 history as infrastructure-era
data, not alerting targets — `ci-health-check.sh` only evaluates the most
recent 5 finished runs for this reason.
