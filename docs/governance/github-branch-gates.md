# GitHub Mirror And Fallback Gates

GitHub is a secondary mirror after the Forgejo-primary migration. The canonical
branch, pull request, required CI, and merge evidence live on Forgejo `origin`.

The repository keeps `.github/workflows/ci.yml` and `audit.yml` as fallback
validation for mirrored commits. They are not required evidence for a Forgejo
merge and a GitHub outage must not block delivery.

GitHub-specific dependencies that remain are optional:

1. `actions/checkout`, `actions/setup-node`, `actions/cache`, and
   `pnpm/action-setup` inside `.github/workflows/`;
2. the old GitHub ruleset and retired input-preprocessor required-check stub;
3. `gh` for inspecting the optional mirror.

Do not enable automatic GitHub mirror pushes until the mirror account can update
`main` without bypassing an intended protection rule. Prefer Forgejo's push-mirror
facility or a narrowly scoped mirror credential over a developer token.

Current primary policy and required checks are documented in
`docs/governance/forgejo-branch-gates.md`.
