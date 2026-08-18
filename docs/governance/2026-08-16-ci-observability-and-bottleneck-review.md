# CI Observability And Bottleneck Review (2026-08-16)

Review of Forgejo/GitHub CI observability and performance, with the fixes
implemented in this change. Data was collected live from the Forgejo REST API
(`actions/tasks`, `actions/runs/{id}/jobs`, `actions/runs/{id}/logs`) and the
GitHub anonymous API (`actions/runs`, `runs/{id}/jobs`).

## Findings

### Observability gaps (evidence)

| # | Gap | Evidence |
|---|---|---|
| G1 | Forgejo job-log API returns stale/wrong bodies | Run 640 (executed 08-16) log zip content timestamps are 2026-08-08; run 630 logs 404 `resource does not exist`. Already noted in `ci.yml` comment (2026-08-09 PR #256) |
| G2 | No cross-run metric persistence / trend | Baseline drifted: static comment baseline wall 3.6–6.0m vs measured median 6.5m (08-16) with no detection surface |
| G3 | No alerting | Runs 3–619 had 24–48h walls (see below); nothing surfaced them proactively |
| G4 | No failure-rate statistics | Last 40 runs: 38% run-level failure; gate-test all-history failure rate 18% (91/503) |
| G5 | Split-platform observability | GitHub: failure-evidence artifacts + resource observation; Forgejo: text failure-tail only |
| G6 | Forgejo runner resource observation written but unwired | `observe-windows-runner-resources.ps1` exists with sampling params, referenced by no workflow |

### Historical context correction

Forgejo runs 3–619 (2026-07-mid → 2026-08-13) show wall 24–48h as the *norm*
(shared runner queueing), not a one-off incident. Run 620+ (2026-08-16) dropped
to 5–7m after the Windows burst-runner + pnpm-store persistence + cache-enable
changes (Forgejo runs 130–140, 218–234). The earlier "08-09→08-13 stuck
window" framing in the working review was incorrect; the whole pre-620 era was
queueing-bound.

### Bottlenecks (measured)

| Job | Forgejo (no cache) | GitHub (cached) | Note |
|---|---|---|---|
| gate-test | 4.2–5.4m | 164–186s | largest block; GitHub 77% is Test root workspace |
| gate-fast | 2.7–4.2m | 89–143s | turbo serial typecheck ~100s mitigated by TURBO_CONCURRENCY=4 |
| gate-web-e2e | 1.7–3.6m | 100–124s | Chromium install ~27s on GitHub |
| gate-drift | 0.9–2.1m | 30–59s | — |
| **wall** | **5.2–7.1m** | **~3m** | ~2x gap |

Root causes: no turbo cache on Forgejo, Windows Podman + linux/amd64 container
overhead, and a serial packages-test segment inside gate-test.

## Implemented

1. **A1 metrics persistence** — `ci-status-report.sh` appends run metrics to
   `.los-runtime/ci-metrics/runs.jsonl` (default) and gains `--trend [N]` /
   `--no-record`. Trend view: median/mean wall, per-job median + failure rate,
   anomalies > 15m.
2. **A2 step-level self-report** — `ci-gate.sh` writes
   `/tmp/los-gate-summary.json` (per-phase elapsed) via a bash-3.2-safe temp
   record; `.forgejo/workflows/ci.yml` adds `Emit gate summary (gate-fast)`
   and `Emit test timings summary (gate-test)` steps; `.github/workflows/ci.yml`
   reports the gate summary into `GITHUB_STEP_SUMMARY`.
3. **A3 alerting** — new `tools/ci-health-check.sh`: stuck run (>15m wall,
   scoped to last 5 finished runs), stalled task (>30m open), optional
   `--include-failures`. Exit 1 on anomaly; cron/launchd wiring documented in
   `docs/operations/ci-observability.md`.
4. **B1 Forgejo turbo cache** — `TURBO_CACHE_DIR: /root/.local/share/turbo` on
   gate-fast/gate-test, relying on the runner volume mapping that already
   persists `~/.local/share/pnpm/store`. Verification checklist in the ops doc.

## Not done / follow-ups

- Forgejo failure-evidence artifacts: `artifact-canary.yml` proved roundtrip
  works, but instance storage quota/cleanup was not inspected; enable after
  audit.
- Forgejo runner resource observation wiring (G6): `observe-windows-runner-resources.ps1`
  needs a gate-test wrapper; answers whether agent 3-group parallelism saturates
  the runner.
- Stuck-run fast-fail: timeout-minutes existed but pre-620 runs still took
  24–48h; investigate Forgejo-side timeout enforcement / runner heartbeat
  recovery.
- gate-test serial segment: packages tests run after agent groups; parallelize
  or overlap with coverage.

## Follow-up (2026-08-18): turbo cache tuning

B1 verified: gate-fast 2.2–2.8m on runs 646–657 (was 2.7–4.2m). The follow-up
change (same branch family as this review) tightens the cache configuration
and makes the checklist machine-checked:

- `turbo.json`: `globalEnv` trimmed to `[NODE_ENV]` (DB/test-only vars were
  cache-key volatility — `LOS_TEST_RUN_ID` is a per-run UUID and the `test`
  task is `cache: false`, so hashing those vars could silently bust every
  entry); `globalDependencies: ["tsconfig.base.json"]` added (root tsconfig
  was not in turbo's global hash → stale cache hits on compiler-option
  changes; verified via `turbo check --dry=json`, `globalCacheInputs.files`
  was empty).
- `tools/ci-gate.sh` phase 1 now folds the turbo run summary into the gate
  summary JSON (`"turbo": {cached,total,tasks,cache_hits,cache_misses}`),
  giving every run a machine-readable hit rate; `tools/observe-turbo-cache.sh`
  (new) reports the persisted `TURBO_CACHE_DIR` capacity, wired as a gate-fast
  step. CI log staleness (G1) is no longer a reason to hand-verify the cache.
- Cost note: the `globalDependencies`/`globalEnv` change invalidates the
  existing hash family once (one cold typecheck on the runner), then the cache
  is stable and strictly more correct.

## Verification

- `bash tools/ci-status-report.sh --trend 30` — works from recorded JSONL.
- `bash tools/ci-health-check.sh` (healthy) / `--include-failures` (reports
  run 637 failure, exit 1) / `--wall-min 0.1` (reports recent stuck runs).
- `bash tools/ci-gate.sh --no-tests` — 12 phases, writes
  `/tmp/los-gate-summary.json` with per-phase elapsed (Security 35s, Unwired
  28s, Structure 27s on this host).
- `tools/ci-workflow-policy.test.mjs` — asserts job needs/concurrency; the
  added env keys and steps do not alter those invariants.
