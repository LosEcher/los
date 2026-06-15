# GitHub Branch And Merge Gates

## Observed Current State

Checked on 2026-06-15 from the local `origin` remote
`https://github.com/LosEcher/los.git`.

The repository-owned GitHub Actions gate is `.github/workflows/ci.yml`.
It runs on:

1. `push` to `main`;
2. `pull_request` targeting `main`;
3. manual `workflow_dispatch`.

The workflow has one job, `gate`, on `ubuntu-latest` with a 10 minute timeout.
It starts PostgreSQL 16, sets:

```bash
DATABASE_URL=postgres://los:los@localhost:5432/los_test
TEST_DATABASE_URL=postgres://los:los@localhost:5432/los_test
NODE_ENV=test
```

Then it checks out the repo, installs pnpm and Node 22, runs
`pnpm install --frozen-lockfile`, and finally runs:

```bash
pnpm run gate
```

The current root script expands `pnpm run gate` to:

```bash
turbo check \
  && ./tools/check-structure.sh \
  && ./tools/check-state-machine-bypass.sh \
  && ./tools/check-contracts.sh \
  && pnpm test
```

`pnpm run pre-push` is only a local shorthand for `pnpm run gate`; it is not
itself a Git hook unless an operator installs a hook outside the repository.

## Verified GitHub Server State

GitHub authentication and repository settings were verified on 2026-06-15 with
the proxy environment cleared:

```bash
HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= https_proxy= http_proxy= all_proxy= gh auth status
```

The repository default branch is `main`, and the branch object reports
`protected: true`. The protection is implemented by a repository ruleset rather
than the legacy branch-protection endpoint: `GET /branches/main/protection`
returns `Branch not protected`, while `GET /rulesets/17481877` returns active
ruleset `main-protection`.

Ruleset `main-protection` applies to `refs/heads/main` and enforces:

1. required status check context `gate`;
2. branch deletion protection;
3. non-fast-forward protection.

The ruleset has no bypass actors, and `current_user_can_bypass` is `never`.
It does not require PR review by itself. Direct pushes to `main` are allowed
only when the pushed commit can satisfy required status check `gate`.

Use these commands to re-check server state:

```bash
HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= https_proxy= http_proxy= all_proxy= gh auth status
HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= https_proxy= http_proxy= all_proxy= gh api repos/LosEcher/los/branches/main
HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= https_proxy= http_proxy= all_proxy= gh api repos/LosEcher/los/rulesets/17481877
HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= https_proxy= http_proxy= all_proxy= gh run list \
  --repo LosEcher/los --branch main --limit 10 \
  --json databaseId,status,conclusion,workflowName,headSha,event,createdAt,updatedAt,url
```

The local shell may have proxy variables that break GitHub CONNECT requests.
If `gh`, `curl`, `git`, or `jj git fetch` fail with `Proxy CONNECT aborted`,
clear the proxy variables for that command or fix the proxy before treating
GitHub state as unreachable.

## Push Rule

Before pushing any branch that may become `main`:

1. inspect the diff and confirm it contains only the intended files;
2. run the minimum gate from ADR 0014 for the touched behavior;
3. run `pnpm run gate` before pushing implementation changes or stacked
   changes;
4. for docs-only changes, run the documented docs gate unless the doc changes
   a runtime contract, branch policy, package boundary, or API surface.

For this branch-policy document, the minimum verification is:

```bash
./tools/check-contracts.sh
```

Use `pnpm run gate` when the same commit also changes code, package scripts,
workflow files, contract files, or runtime behavior.

After pushing, verify the remote GitHub Actions result. A local green gate is
not a substitute for the remote run, because the remote job verifies the clean
checkout, frozen lockfile install, PostgreSQL service setup, Node version, and
CI environment.

## Merge Rule

Merge into `main` only when all applicable evidence is present:

1. local gate evidence is recorded in the final change note or PR summary;
2. GitHub Actions `CI / gate` for the pushed commit or PR head is green;
3. any change-type-specific gate from ADR 0014 has passed;
4. run-chain changes have a fragment in `docs/governance/run-chain-changes/`
   when they touch the surfaces listed in that directory's README;
5. operation smokes are added or updated when the change claims live gateway,
   executor, provider, database, node, or SSE behavior.

If GitHub branch protection cannot be reached from the current shell, do not
use that as permission to merge. The project merge rule remains: local
applicable gate plus green remote CI for the exact commit being merged.

## Recovery When A Gate Fails

When the local or remote gate fails:

1. keep the failed command, commit SHA, and relevant log URL or local command
   output in the working notes;
2. fix the underlying source or configuration problem rather than bypassing the
   check;
3. rerun the narrow failed command first;
4. rerun `pnpm run gate` before pushing a fix to `main` or merging a PR;
5. after pushing, verify the new GitHub Actions run for the fixed commit.

For CI infrastructure failures, separate the surfaces:

1. workflow configuration: `.github/workflows/ci.yml`;
2. local gate definition: root `package.json` scripts;
3. repository server policy: GitHub branch protection and rulesets;
4. run result: GitHub Actions run status for a specific commit.

Do not flatten those four surfaces into a single statement such as "CI is
green" without naming which commit and which surface was checked.
