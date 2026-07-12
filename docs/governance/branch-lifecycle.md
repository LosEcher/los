# Branch Lifecycle (Forgejo Primary)

Canonical intent rules live in root `AGENTS.md`. This playbook defines the
single-worktree, `jj`-first lifecycle after Forgejo becomes the primary repo.

## Remote Roles

| Remote | Role | Required local name |
|--------|------|---------------------|
| Forgejo `los/los` | Primary source, PRs, required CI, branch protection | `origin` |
| GitHub `LosEcher/los` | Optional backup mirror | `github` |

`origin/main` is the only authoritative merge state. GitHub status, Actions,
rulesets, and PR state are not completion evidence for Forgejo merges.

Expected local layout:

```bash
git remote get-url origin   # Forgejo
git remote get-url github   # optional GitHub mirror
```

## Branch Policy

1. `main` is the only long-lived branch on Forgejo.
2. One intent uses one short-lived `feat/`, `fix/`, `chore/`, or `docs/` bookmark.
3. Integration batches use `integration/<date>-<label>` and are deleted after merge.
4. Merge only through Forgejo after the exact PR head has all required checks green.
5. Delete a branch when it has no unique commits or all patches are absorbed by `origin/main`.

Use the repository scripts:

```bash
bash tools/branch-closeout.sh
bash tools/branch-prune-origin.sh
```

`branch-prune-origin.sh` is dry-run by default. `--apply` deletes remote branches
and still requires explicit operator consent.

## Required Forgejo Gates

Forgejo must protect `main` with:

1. deletion and non-fast-forward protection;
2. pull-request merge policy;
3. required successful checks from `.forgejo/workflows/ci.yml`:
   `gate-fast`, `gate-test`, and `gate-drift`;
4. no merge while a required check is pending or failed.

The retired `gate-test (input-preprocessor)` stub is legacy GitHub compatibility
and must not be configured as a Forgejo required check.

## Automated Governance

The `branch_cleanup` governance job uses:

```bash
LOS_BRANCH_GOVERNANCE_PRIMARY_REMOTE=origin
LOS_BRANCH_GOVERNANCE_MIRROR_REMOTE=github
LOS_BRANCH_GOVERNANCE_MIRROR_SYNC=0
```

It audits and safely deletes absorbed branches from the primary remote. Optional
mirror sync is disabled by default because GitHub protection and credentials may
reject direct pushes. Enable it only after the mirror account has an explicit,
audited push path.

Older persisted summaries keep working through the legacy `forgejo*` and
`staleOriginBranches` aliases; new summaries use `mirror*` and
`stalePrimaryBranches`.

## GitHub Mirror

GitHub is not required for build, tests, merge, or closeout. Keep
`.github/workflows/` only as a fallback validation surface while the mirror is
maintained. A GitHub outage must not block Forgejo delivery.

## Session Closeout

Every edited session reports `jj status`, dirty paths, current change/bookmark,
Forgejo PR state, checks run, checks not run, and residual risk.

Related:

- `docs/governance/forgejo-branch-gates.md`
- `docs/governance/github-branch-gates.md`
- `tools/branch-closeout.sh`
- `tools/branch-prune-origin.sh`
- `SKILL.md`
