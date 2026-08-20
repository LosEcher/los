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
| `tools/path-gate.mjs` | classify PR paths; skip heavy `gate-test` / e2e steps | `skip_heavy` step output |

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

## Path-gate (docs/tools-only skip)

`gate-test` and `gate-web-e2e` classify the PR path set with
`tools/path-gate.mjs` and skip install/test steps when
`steps.path-gate.outputs.skip_heavy == 'true'`. The jobs themselves still
run and stay green — they are required checks. `exit 0` inside the classify
step does **not** skip later steps (runs 779/780, PR `#295`). Record:
`docs/operations/2026-08-18-path-gate-skip-failure.md`.

## B1 verification checklist (Forgejo turbo cache)

`.forgejo/workflows/ci.yml` sets `TURBO_CACHE_DIR: /root/.local/share/turbo`
on `gate-fast` (and `gate-test` as a no-op safeguard — that job's steps run
per-package node test runners, no turbo).

**Status (corrected 2026-08-18):** between B1 enablement and this correction
the turbo cache was **not actually persisted**. The runner persists only the
pnpm store, as a podman named volume (`forgejo-pnpm-store`); `TURBO_CACHE_DIR`
fell in the ephemeral job-container filesystem and was wiped after every job —
run 775 and run 776 (identical content) both reported `turbo: {cached: 0,
total: 16}` with observe-step `entries: 16` (a shared volume would show ≥32
entries and ≥16 hits). The 2.2–2.8m gate-fast on runs 646–657 was the
**no-cache** value (TURBO_CONCURRENCY=4 + path-gating), not a warm-cache one.
Fix: a second named volume `forgejo-turbo-cache` mounted at
`/root/.local/share/turbo` (runner-host config; see
`docs/operations/2026-08-18-runner-topology-and-turbo-persistence.md`).
Acceptance signal: gate summary `turbo.cached > 0` on the run after the first
cold write.

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
- `tools/observe-turbo-cache.sh --json` (step `Observe turbo cache capacity`
  in gate-fast) reports the persisted directory's entry count and size. Exit 2
  if the directory is missing — a signal the runner volume is missing.

**If the cache is not hitting:**

1. Check the gate summary `turbo` block: `cached` ≈ 0 with `total` > 0 on
   consecutive runs with unchanged package content means the volume is not
   mounted. Verify on the runner host:
   `podman exec forgejo-runner-win-canary sh -c "cat /data/config.yaml" | grep -E 'options:|valid_volumes'`
   — `forgejo-turbo-cache` must appear in both. The runner host is
   `ssh win-los` (DESKTOP-R45553O, see the 2026-08-18 runner-topology doc).
2. Check `observe-turbo-cache.sh` output: `exists:false` means the volume is
   not mounted (or TURBO_CACHE_DIR unset).
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
