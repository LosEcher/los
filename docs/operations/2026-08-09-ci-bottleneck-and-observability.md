# CI bottleneck and observability — 2026-08-09

Evidence from Forgejo Actions on node34 (primary), PR `#256` runs `584`/`585`,
and green baseline runs `576`–`583`.

## Green baseline (same day)

| Job | Avg | Range |
| --- | ---: | ---: |
| gate-drift | ~0.7m | 0.4–1.1m |
| gate-web-e2e | ~1.3m | 1.1–1.9m |
| gate-fast | ~2.4m | 2.1–3.2m |
| gate-test | ~3.9m | 3.6–4.9m |
| **wall-clock** (parallel) | **~4.4m** | **3.6–6.0m** |

Critical path ≈ `max(gate-fast, gate-test)` (~4m), not the sum of four jobs.

## Bottlenecks (ranked)

1. **Per-job checkout + `pnpm install` ×4** — largest fixed cost; cold registry
   jitter still visible in older logs (10–35s/package).
2. **`gate-test` length** — agent 3-way parallel + other packages + coverage.
3. **Runner concurrency** — jobs sharing `win-ci-jj` / limited pool can queue
   e2e after test (seen on run `585`).
4. **Observability gap** — commit status reports failure correctly, but
   `GET .../actions/jobs/{id}/logs` often returns **stale bodies** from older
   task IDs (observed on PR `#256`: status said fail, log API returned 2026-08-07
   success tails). Diagnosis then requires UI or in-job failure tails.

## Optimizations worth doing

| Priority | Change | Expected effect |
| --- | --- | --- |
| P0 | **In-job failure tail** (done in this change) | Diagnose red without broken log API |
| P0 | **`tools/ci-status-report.sh`** (done) | Wall/job duration from API without UI |
| P1 | Path filter: web-only PRs run slim `gate-test` (skip agent groups) | Test ~4m → ~1–2m on pure web PRs |
| P1 | Pre-warm pnpm store on runners / prefer-offline health | −0.5–1.5m per install |
| P2 | Shared install artifact across jobs | Harder on Windows/act; measure first |
| P2 | Keep e2e on dedicated label with spare capacity | Cut queue time under load |

Do **not** re-serialize jobs with `needs: gate-fast` for wall-clock; that was
already measured as a regression (~5.2m → ~max).

## Observability plan

### Already landed (this change)

1. `gate-test` / `gate-web-e2e` write `tee` logs under `/tmp/los-ci-logs/` and on
   `failure()` print a marked **failure tail** into the step log (survives even
   when the Jobs log API is wrong).
2. `bash tools/ci-status-report.sh [PR#|--sha SHA]` prints combined commit
   status + recent run wall/job durations.

### Next (not in this PR unless needed)

1. **Status description enrichment** — if Forgejo allows custom check
   descriptions from the job, append first failing `✘` line (max 140 chars).
2. **Log API trust probe** — weekly canary: compare job log first line timestamp
   to `run_started_at`; alert when skew > 1 day (detects stale log map).
3. **Path-aware required checks** — document which contexts must be green for
   web-only vs full monorepo PRs so operators do not wait on irrelevant agent
   suites.
4. **Superseded-run waste** — already cancelled via concurrency group; keep
   measuring cancelled runner-seconds so double-push cost stays visible.

## PR #256 failure class (fixed in follow-up commit)

Local full e2e reproduction:

- `#chat$` / `#work$` assertions broke after deep-links (`#chat?session=`,
  `#work/<id>`).
- Mobile Work **list→detail stack** hid detail until selection; bare `#work`
  tests and multi-item flows needed back/list navigation or deep-links.

`gate-test` early red (~2.3m vs ~4m green) on pure-web heads was not reproduced
locally as a web unit failure; treat as possible infra/agent flake until the
new failure-tail step captures the real command. Re-run after e2e fix.
