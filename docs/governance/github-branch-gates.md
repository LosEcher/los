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

The single GitHub test job samples its expensive root test command every five
seconds through `tools/observe-command-resources.mjs`. The JSON record is
written to the runner temporary directory and copied to the job summary.
GitHub's job timestamps are the source for full job duration, while the observer
reports command duration, peak sampled process-group CPU/RSS, host memory/swap,
and cgroup v2 values when the hosted runner exposes them.

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

Do not enable automatic GitHub mirror pushes until the mirror account can update
`main` without bypassing an intended protection rule. Prefer Forgejo's push-mirror
facility or a narrowly scoped mirror credential over a developer token.

Current primary policy and required checks are documented in
`docs/governance/forgejo-branch-gates.md`.
