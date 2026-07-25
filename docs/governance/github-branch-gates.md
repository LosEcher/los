# GitHub Mirror And Fallback Gates

GitHub is a secondary mirror after the Forgejo-primary migration. The canonical
branch, pull request, required CI, and merge evidence live on Forgejo `origin`.

The repository keeps `.github/workflows/ci.yml` and `audit.yml` as fallback
validation for mirrored commits. They are not required evidence for a Forgejo
merge and a GitHub outage must not block delivery.

GitHub-specific dependencies that remain are optional:

1. `actions/checkout`, `actions/setup-node`, `actions/cache`, and
   `pnpm/action-setup` inside `.github/workflows/`;
2. the old GitHub ruleset contexts that still name the retired package matrix;
3. `gh` for inspecting the optional mirror.

As verified through the GitHub API on 2026-07-25, ruleset `main-protection`
still requires the retired six-package `gate-test (*)` contexts plus the
input-preprocessor compatibility stub. The current workflow replaces the
package matrix with one `gate-test` job because root `pnpm test` already runs
the complete workspace. Before using GitHub pull requests again, update the
ruleset to require `gate-fast`, `gate-test`, and `gate-drift` as part of the
workflow rollout. The workflow no longer emits the retired input-preprocessor
stub. Until that ruleset migration is complete, the repository workflow is
suitable for mirror validation but the old GitHub required-check set cannot be
satisfied.

The single GitHub test job samples its expensive root test command every five
seconds through `tools/observe-command-resources.mjs`. The JSON record is
written to the runner temporary directory and copied to the job summary; it is
not committed or uploaded as a retained artifact. GitHub's job timestamps are
the source for full job duration, while the observer reports command duration,
peak sampled process-group CPU/RSS, host memory/swap, and cgroup v2 values when
the hosted runner exposes them.

Do not enable automatic GitHub mirror pushes until the mirror account can update
`main` without bypassing an intended protection rule. Prefer Forgejo's push-mirror
facility or a narrowly scoped mirror credential over a developer token.

Current primary policy and required checks are documented in
`docs/governance/forgejo-branch-gates.md`.
