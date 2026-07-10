# Branch Lifecycle (Self-Iteration, Main-First)

Canonical intent rules live in root `AGENTS.md` (one branch, one intent). This
document is the **operating playbook** for a single-worktree, self-driven repo
with no external fork traffic.

## Target State

| Surface | Target |
|---------|--------|
| **Default** | `main` is the only long-lived branch on `origin` and `forgejo` |
| **Local** | Checkout `main`; use **jj** colocate (detached git HEAD is normal) or ephemeral git branches |
| **Remote feature branches** | Exist only while a PR is open or during a short **observation window** |
| **Integration batches** | Short-lived `integration/YYYY-MM-DD-*` branches; delete immediately after merge to `main` |

## When To Branch

1. **Single intent** → `feat/`, `fix/`, `chore/`, `docs/` (one PR, one merge).
2. **Stacked batch** (several intents already reviewed, one merge train) →
   `integration/<date>-<label>` (example: PR #117). Rebase onto `main` before
   opening the integration PR; delete the integration branch after merge.
3. **Do not** keep parallel locals (`feat/foo` + `fix/bar` + stale `chore/*`) after
   merge — they only recreate confusion about what shipped.

## Observation Window (Branches Not Yet Safe To Delete)

Use when automation classifies `review` / `extract` / `archive` (see metrics
below). Default for self-iteration:

| Metric | Observe | Clear to delete |
|--------|---------|-----------------|
| GitHub PR | `MERGED` + head SHA had green CI | After 0–7 days if metrics below pass |
| `ahead` vs `origin/main` | `git rev-list --left-right --count origin/main...origin/<branch>` | `ahead = 0` |
| Patch absorption | `git cherry origin/main origin/<branch>` | No lines starting with `+` |
| Runtime | N/A for pure chore/docs | `pnpm run gate` on `main` post-merge |

**Squash-merge caveat:** `ahead` may be &gt; 0 and `git cherry` may show `+` even
when **content** is on `main` (new commit hashes). If PR is `MERGED` and the
capabilities are present on `main` (grep / focused test), treat as absorbed and
delete the remote branch.

## Automated Governance

The `branch_cleanup` governance job (`computeBranchHygieneSummary` +
`applyBranchCleanupFix` in `@los/agent`) already:

1. Re-attaches detached HEAD when safe (skips `.jj` colocate).
2. Fast-forwards `forgejo/main` from `origin/main` when drift is `syncable`
   (`LOS_BRANCH_GOVERNANCE_FORGEJO_SYNC` defaults on).
3. Deletes `origin/*` branches when `ahead === 0` **or** all `git cherry`
   lines are `-` (patches absorbed).

Run manually (gateway/CLI governance sweep) or wait for the GA loop seed job.
**It will not delete** branches with `git cherry` `+` lines — those need the
observation rules above or a manual prune.

## Manual Closeout After Integration Merge (Example: #117)

Read-only audit (2026-07-05):

```bash
git fetch origin --prune
git branch -r --merged origin/main   # safe deletes (git ancestry)
```

**Safe `origin` delete now** (`ahead=0`):

- `chore/ci-known-failure-tracking`
- `chore/remove-input-preprocessor`
- `feat/web-chat-streaming`
- `feat/worker-ask-escalation-wiring`
- `feat/worker-messages-and-test-infra`
- `fix/worker-ask-loop-defects`
- `integration/2026-07-05-github-sync`

**Delete after absorption check** (PR merged; content on `main`):

- `feat/worker-ask-resume-trigger` — `git cherry` shows patch equivalent on `main`
- `feat/worker-ask-resume-graph-convergence` — PRs #115/#116 merged; features
  (`worker_answer` NOTIFY, `code_topology_audit`, ask-resume anchors) present on
  `main`; remote tip still shows `+` in `git cherry` (squash history)

**Local** (when on `main`, merged tips only):

```bash
git branch -d chore/ci-retire-input-preprocessor-check \
  chore/remove-input-preprocessor feat/web-chat-streaming \
  fix/worker-ask-loop-defects feat/worker-ask-resume-trigger
```

**Remote prune** (requires explicit operator consent in this environment):

```bash
./tools/branch-prune-origin.sh --apply
```

**Forgejo** (mirror): after `origin` prune, delete stale `forgejo/chore/*` and
`forgejo/feat/*` if they still exist; keep `forgejo/main` aligned with
`origin/main` (0/0 drift as of 2026-07-05).

## CI / Ruleset Hygiene (P2)

Ruleset `main-protection` still requires `gate-test (input-preprocessor)` while
the package was removed in `9bb74ed`. A **stub job** in `.github/workflows/ci.yml`
satisfies the check until the ruleset is updated.

1. GitHub → Rules → `main-protection` → remove required check
   `gate-test (input-preprocessor)`.
2. Merge a small `chore/ci` PR removing `gate-test-input-preprocessor-retired`
   from `ci.yml` (no stub once ruleset is clean).

Re-verify:

```bash
HTTPS_PROXY= HTTP_PROXY= gh api repos/LosEcher/los/rulesets/17481877 \
  --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
```

## jj + Single Worktree

- One worktree under `projects/los` matches the main-first model.
- Prefer `jj new main` / feature change → `jj git push` to a **short-lived**
  remote branch → PR → merge → `jj git fetch` → delete remote branch.
- Do not treat lingering `git branch` names as source of truth; trust
  `origin/main` and PR state.

## Session End Check (Agents)

At the end of **every** support session that touched this repo, agents must
run the judgment in `SKILL.md` → **Workflow: Session Closeout And Branch
Governance** and the short gate in root `AGENTS.md` → **Session Closeout Gate**.

Minimum questions (yes/no, with evidence):

1. Uncommitted work that belongs on a PR?
2. Feature bookmark / remote branch still needed?
3. Stale worktrees or parallel locals to drop after merge?
4. Any “done” claim that is only chat text (upgrade to `[E]` or retract)?

Do not treat “smoke passed in chat” as permission to skip branch hygiene.

## Related

- `docs/governance/github-branch-gates.md` — merge gates and `branch-closeout.sh`
- `tools/branch-closeout.sh` — pre-merge read-only checklist
- `tools/branch-prune-origin.sh` — post-merge origin prune (dry-run default)
- `SKILL.md` — Session Closeout And Branch Governance workflow
- `AGENTS.md` — Session Closeout Gate