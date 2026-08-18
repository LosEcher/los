# Path-Gate Skip Failure (2026-08-18)

Operational record. `#290` added a path-gate so docs/tools-only PRs would
skip `gate-test` / `gate-web-e2e` heavy steps. PR `#295` (docs-only) still
ran the full suite for ~9m30s on runs `779` / `780`. Classification was
partly correct; the skip never reached the job.

This file is the contract for the fix. Implementation must match the
invariants and acceptance checks below. Classifier and wiring tests are the
mechanical gate; job logs on a later docs-only head are the external
acceptance surface.

## Evidence (runs 779 / 780)

PR `#295` changed two files:

- `docs/operations/2026-08-18-runner-topology-and-turbo-persistence.md`
- `docs/operations/ci-observability.md`

| Run | Event | SHA | Wall | gate-test verdict | What ran next |
| --- | --- | --- | ---: | --- | --- |
| 779 | `opened` | `27b1832e` | 9m23s | `skipping heavy suite` | agent groups 1/3–3/3 started |
| 780 | `synchronized` | `c7d376dd` | 9m30s | same | `agent-groups 266s` + `packages 204s` + `coverage 9s` |

Same-window code PR `#294` (run 777) was 9m18s. Path-gate saved no wall
time. Source: Forgejo `GET /actions/runs/{779,780}` and
`GET /actions/jobs/{2693,2697,2694,2698}/logs`.

## Root causes

Two independent defects. Either one is enough to keep the heavy suite on.

### 1. `exit 0` only ends the current step

`.forgejo/workflows/ci.yml` printed skip then `exit 0`. In Forgejo/GitHub
Actions that marks the step successful and continues the job. Subsequent
steps (`Prepare pnpm`, install, agent groups, packages, coverage, Playwright)
had no `if:`.

Run 780 timeline:

- `13:00:50Z` `PATH-GATE: only tools/docs/CI-metadata changed — skipping heavy suite`
- `13:02:10Z` `=== agent group 1/3 ===`

`gate-test` is a required check. The job must stay green. The wrong
mechanism was used to keep it green.

### 2. e2e regex still had a group-level `$`

`#291` fixed only the `gate-test` pattern. `gate-web-e2e` kept:

```
^(tools/|docs/|\.forgejo/|README.md|…|pnpm-workspace.yaml)$
```

`docs/operations/foo.md` does not match `docs/` when `$` closes the whole
group. Same `#295` files therefore produced:

- gate-test: `skipping heavy suite` (then defect 1)
- gate-web-e2e: `non-safe paths detected — running full suite`

`tools/ci-workflow-policy.test.mjs` only locked `needs` and
`TURBO_CONCURRENCY`, so the skip control-flow and the duplicated regex
could drift.

### Not the cause on #295 (latent)

`git fetch --depth=1 origin main` then `git diff FETCH_HEAD HEAD` is a
two-dot tree compare. A PR behind `main` will include later main-only
package files and fail closed (run full). `#295` was based on then-`main`;
gate-test classification was correct.

## Invariants

1. `gate-test` and `gate-web-e2e` remain required-check names. Do not skip
   the whole job with a job-level `if:`.
2. Skip is a step-level `if:` on every expensive step after classification,
   driven by `steps.path-gate.outputs.skip_heavy`.
3. One classifier (`tools/path-gate.mjs`) is the source of truth. Workflows
   do not inline a second regex.
4. Safe paths are prefixes `tools/`, `docs/`, `.forgejo/` plus the exact
   root files `README.md`, `LICENSE`, `.gitignore`, `.editorconfig`,
   `.env.example`, `pnpm-workspace.yaml`. Any other path is `full`.
5. Fail closed: if the file list cannot be produced, `skip_heavy=false`.
6. Classification always exits 0. A skip is not a job failure.
7. `gate-fast` and `gate-drift` always run. Structural regressions in
   `tools/` stay on the fast path.
8. The classifier and the workflow wiring are covered by tests that run in
   `gate-fast` (`check-ci-workflow-policy.sh`), so a docs-only PR cannot
   silently drop the skip.

## Designed fix

1. `tools/path-gate.mjs` lists changed paths, classifies, prints a
   machine-readable `PATH-GATE: skip_heavy=true|false` line plus the file
   list, and writes `skip_heavy=…` to `$GITHUB_OUTPUT` when that file exists.
2. Both heavy jobs: `id: path-gate` then
   `if: steps.path-gate.outputs.skip_heavy != 'true'` on install and test
   steps. Emit/failure-tail steps keep `always()` / `failure()`.
3. File listing: three-dot `base...HEAD` when a merge-base exists; otherwise
   two-dot (logged as `mode=two-dot`). Missing list → `full`.
4. Tests:
   - `tools/path-gate.test.mjs` — docs-only / tools-only / mixed / empty /
     list-failure / `docs/operations/foo.md` must skip.
   - `tools/ci-workflow-policy.test.mjs` — both jobs call the script; every
     non-`always()`/`failure()` step after path-gate has the `if:` guard;
     no inline `grep -qvE` skip regex.

## Defeated alternatives

| Option | Why not |
| --- | --- |
| Job-level `if:` to skip `gate-test` | Required check disappears; merge protection fails or must be loosened |
| Keep `exit 0` and wrap later steps in one shell | Same job still pays install; easy to add an unguarded step later |
| Dorny `paths-filter` / extra Action | New dependency on a runner that already avoids marketplace actions |
| Make GitHub workflow skip too | Out of scope; GitHub is the mirror. Recorded as follow-up |
| Drop `tools/` from the safe set | `#290` design: `gate-fast` + `gate-drift` still cover tools |

## Acceptance

Local (gate-fast surface):

```bash
node --test tools/path-gate.test.mjs tools/ci-workflow-policy.test.mjs
pnpm check:ci-workflow-policy
```

A docs-only PR (or a follow-up canary that only touches `docs/`):

- log contains `PATH-GATE: skip_heavy=true`
- `Prepare pnpm` / `Test agent` / `Test Web operator paths` are **skipped**
- job conclusion is `success`
- wall time is checkout + `git fetch` + classify (tens of seconds), not ~9m

A `packages/` change still runs the full suite.

## Follow-up (not this change)

- GitHub `.github/workflows/ci.yml` has no path-gate.
- Two-dot fallback on a stale PR is fail-closed (extra CI), not a skip leak.
