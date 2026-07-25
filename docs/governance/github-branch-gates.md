# GitHub Mirror And Fallback Gates

GitHub is a secondary mirror after the Forgejo-primary migration. The canonical
branch, pull request, required CI, and merge evidence live on Forgejo `origin`.

The repository keeps `.github/workflows/ci.yml` and `audit.yml` as fallback
validation for mirrored commits. They are not required evidence for a Forgejo
merge and a GitHub outage must not block delivery.

GitHub-specific dependencies that remain are optional:

1. `actions/checkout`, `actions/setup-node`, `actions/cache`, and
   `pnpm/action-setup` inside `.github/workflows/`;
2. the repository ruleset and classic branch protection surfaces, which must
   remain aligned when required checks change;
3. `gh` for inspecting the optional mirror.

As verified through the GitHub API on 2026-07-25, repository ruleset
`17481877` (`main-protection`) and classic `main` branch protection both require
`gate-fast`, `gate-test`, and `gate-drift`. The ruleset also rejects deletion
and non-fast-forward updates. Classic protection keeps strict status checks,
disallows force pushes and deletion, and requires zero approving reviews.

Both policy surfaces previously required the retired package matrix and
`gate-test (input-preprocessor)`. Updating only the ruleset left pull request
`#172` blocked, so required-check migrations must inspect and update both
surfaces, record their before/after context sets, and verify the pull request's
merge state after the change. Canary run `30162236325` emitted the three new
required contexts on exact head `b924fa65`; pull request `#172` then changed
from `BLOCKED` to `CLEAN` and merged as `499fc6b3`.

The current workflow has one `gate-test` job because root `pnpm test` already
runs the complete workspace. `gate-web-e2e` remains visible and runs on every
pull request, but it is not a GitHub required check. Changing that policy needs
separate reliability and runner-cost evidence.

Forgejo PR `#70` and GitHub PR `#175` show the current mirror delivery rule.
The repositories had equivalent content but non-linear merge histories, so the
Windows observer change used an independent equivalent-patch GitHub PR instead
of pushing Forgejo `main` over protected GitHub `main`. GitHub run
`30170606961` passed all four jobs on head
`76c513a335cf2df7ab57fc57a97deee47713df7b` and merged as
`4ec11f0e6518907cc6f206bf2ea541deba51b0ac`. This result maintains the fallback
mirror; it is not required evidence for the Forgejo merge.

The workflow concurrency group is the event type plus pull-request number or
full ref. A newer head for the same pull request cancels its older run, while
different pull requests cannot cancel each other. Pushes to `main` cancel an
older `push` run for `refs/heads/main`; repeated manual dispatches on the same
selected ref cancel each other. Including the event type prevents a manual
canary from cancelling a push or pull-request run.

GitHub's heavy jobs remain independent of `gate-fast`. Successful run
`30167823333` completed in 230 seconds wall time, with `gate-fast` taking 64
seconds and `gate-test` taking 225 seconds. Adding a fast-gate dependency would
add about one minute to that successful path without reducing its runner time.
The concurrency rule instead limits waste after a new PR head supersedes an
active run. Run `30167769845` is the observed waste sample: before cancellation,
fast, drift, and Web E2E had completed and the root test command had run for 92
seconds. It is classified as superseded, not as a test flake.

Forgejo keeps its existing `needs: gate-fast` policy for `gate-test` and Web
E2E because its local runners have tighter shared-resource constraints. Run
`257` took about 410 seconds wall time and 484 accumulated runner-seconds; full
parallelism could reduce a green path by roughly the 158-second fast gate, but
would not reduce green runner consumption and would spend heavy-job resources
on every fast failure. One run is insufficient evidence to change that policy.

The single GitHub test job samples its expensive root test command every five
seconds through `tools/observe-command-resources.mjs`. The JSON record is
written to the runner temporary directory and copied to the job summary.
GitHub's job timestamps are the source for full job duration, while the observer
reports command duration, peak sampled process-group CPU/RSS, host memory/swap,
and cgroup v2 values when the hosted runner exposes them.

The current provisional Linux baseline has 4 of the required 10 unique heads.
Observed workflows consumed 365--397 runner-seconds with 204--226 seconds wall
time; the root command took 160.261--164.838 seconds and all four sampled swap
peaks were zero. Relative to the historical 915 runner-second matrix this is a
56.6%--60.1% observed range, averaging 58.2%. Do not publish P95, tune cache,
or change runner capacity until the tenth unique head. Keep these hosted Linux
records separate from Forgejo Windows host/container measurements.

When a covered test, coverage, Web E2E, or migration-drift command fails,
`tools/collect-ci-failure-evidence.mjs` creates one evidence directory capped at
10 MiB. It can contain the resource JSON, at most 512 KiB from each test or gate
log, and Playwright failure trace/screenshots that fit the remaining budget.
The manifest records missing inputs as `unavailable` and oversized files as
`cap_exceeded`; a cancelled run with no flushed observer output is never
reported as zero. `actions/upload-artifact@v4` retains the directory for five
days. Successful jobs do not run the collector or upload a retained artifact.
Dependency trees, the pnpm store, and `.turbo` are not valid evidence inputs.
Failures before checkout or Node setup still rely on the platform log because
the repository collector is not available yet. Collector inputs are explicitly
allowlisted and do not include environment variables, but the collector is not
a general content redactor; covered commands must not print production
credentials or raw session transcripts into logs or traces.

The resource JSON in a successful job summary is not a retained artifact. The
runner temporary file is cleaned with the hosted runner, while the summary
follows the run record. Failure bundles are owned by the workflow and expire
after five days through `actions/upload-artifact@v4`. The complete owner,
cleanup trigger, size, and retention table is in
`docs/operations/2026-07-25-ci-cd-observability-priority-and-todo-plan.md`.

Required-context rollback must update both GitHub policy surfaces. Restore a
known-good workflow on a PR, verify the replacement contexts on its exact head,
add/restore them in ruleset `17481877` and classic branch protection, then
remove the broken contexts. Changing only one policy surface can leave the PR
`BLOCKED`, as PR `#172` demonstrated. Keep GitHub rollback independent from
Forgejo protection; neither remote's emergency bypass authorizes bypass on the
other.

Do not enable automatic GitHub mirror pushes until the mirror account can update
`main` without bypassing an intended protection rule. Prefer Forgejo's push-mirror
facility or a narrowly scoped mirror credential over a developer token.

Current primary policy and required checks are documented in
`docs/governance/forgejo-branch-gates.md`.
