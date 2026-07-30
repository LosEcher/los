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
2. Start every new intent from `main@origin` with `jj new main@origin`; do not
   stack an unrelated task on the current feature change.
3. One intent uses one short-lived `feat/`, `fix/`, `chore/`, or `docs/` bookmark.
4. Keep local `main` aligned with `origin/main`. A successful feature push does
   not move `main`; move it only after Forgejo has merged the PR and a fetch
   verifies the new authoritative head.
5. Integration batches use `integration/<date>-<label>` and are deleted after merge.
6. Before merge, inspect the PR file list and commit intent. Split or close a PR
   that combines unrelated package changes, generated baselines, or follow-up work.
7. Merge only through Forgejo after the exact PR head has all required checks green.
8. Delete a branch when it has no unique commits, all patches are absorbed by
   `origin/main`, or its PR is closed as rejected/superseded with the replacement
   evidence retained in the PR body.

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

The delivery workflow also emits `gate-web-e2e`. Current operator policy waits
for all four exact-head contexts before merging, but the server-side required
context set must still be verified through an authorized UI/API surface before
claiming that Forgejo itself enforces `gate-web-e2e`.

**Incident note (2026-07):** PR #96 was merged at 21:49 before `gate-test`
failed at 21:52; PR #92 merged after required checks were cancelled. Both
violated rule 4. Operators must re-verify Forgejo branch protection so that
`gate-fast`, `gate-test`, and `gate-drift` are **required** and merges are
blocked while any required check is pending, cancelled, or failed.

The retired `gate-test (input-preprocessor)` stub is legacy GitHub compatibility
and must not be configured as a Forgejo required check.

`tools/.known-test-failures.txt` is an active gate, not permanent documentation.
When a listed test passes again, `pnpm run gate` reports the entry as fixed and
blocks delivery until the stale baseline is removed in its own bounded change.

## Automated Governance

The `branch_cleanup` governance job uses:

```bash
LOS_BRANCH_GOVERNANCE_PRIMARY_REMOTE=origin
LOS_BRANCH_GOVERNANCE_MIRROR_REMOTE=github
LOS_BRANCH_GOVERNANCE_MIRROR_SYNC=0
```

It audits and classifies absorbed branches but does not check out branches, push
the mirror, or delete remote refs. Apply an approved deletion only through
`tools/branch-prune-origin.sh --apply`; the script remains dry-run by default.
Optional mirror inspection is disabled by default. Mirror pushes remain an
explicit closeout action even when the audit classifies the update as a safe
fast-forward.

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
- `docs/operations/forgejo-delivery.md`
- `tools/branch-closeout.sh`
- `tools/branch-prune-origin.sh`
- `SKILL.md`
