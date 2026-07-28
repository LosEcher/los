# Forgejo Delivery Operations

This runbook covers common repository operations for `los/los`. Forgejo is the
primary repository and `origin/main` is the authoritative merge state. GitHub
is a secondary mirror and must not be used as evidence that a Forgejo delivery
completed.

## Operating Boundaries

1. Use `jj` for local changes, bookmarks, and workspace state. Use Git only for
   remote interoperability and read-only graph inspection.
2. Do not push directly to `main`. Forgejo branch protection applies to admins,
   disables direct push, rejects outdated heads, and requires the configured CI
   contexts.
3. Create and merge normal changes through a Forgejo pull request after its
   exact head passes the required checks.
4. Creating or merging a PR and deleting a remote branch require operator
   intent. Emergency bypasses, force updates, and protection changes require
   separate explicit approval.
5. Never print, commit, log, or save the credential record returned by
   `git credential fill`. Do not use `set -x` while credentials are loaded.

## Remote And Network Truth

Derive the effective server and repository from `origin`; do not copy a stale
host address from an old operation record.

```bash
git remote get-url origin
git remote get-url github
jj bookmark list --all-remotes
```

The current preferred Forgejo route is the Tailscale address used by `origin`.
The LAN address has been observed to time out and is not a fallback unless it
is freshly verified. A `200` response from `/api/v1/version` proves server/API
reachability only; it does not prove repository access, write permission, CI
health, or merge readiness.

```bash
FORGEJO_REMOTE_URL=$(git remote get-url origin)
FORGEJO_SERVER_URL=$(printf '%s' "$FORGEJO_REMOTE_URL" | sed -E 's#(https?://[^/]+).*#\1#')
FORGEJO_REPOSITORY=$(printf '%s' "$FORGEJO_REMOTE_URL" | sed -E 's#https?://[^/]+/##; s#\.git$##')

curl -fsS --max-time 10 "$FORGEJO_SERVER_URL/api/v1/version" | jq '{version}'
```

Keep these variables local to the current shell and unset them at closeout.

## Authentication Choices

The current Forgejo API advertises both `BasicAuth` and
`AuthorizationHeaderToken`.

| Context | Authentication | Judgment |
| --- | --- | --- |
| Repeated automation | Scoped Forgejo access token | Preferred because it is independently revocable and can be limited |
| One-off local operation | Git credential from macOS Keychain with Basic Auth | Supported by the current instance; do not print or persist it |
| Forgejo Actions job | Job-provided `FORGEJO_TOKEN` | Runner-only checkout credential; do not treat it as a local operator token |
| GitHub mirror | `gh` authentication | Separate credential and authorization surface |

`FORGEJO_TOKEN` being absent from the local shell does not mean the Forgejo API
is unusable. It means token-header authentication is unavailable in that shell.
The repository's current `tools/branch-closeout.sh` only supports the token
header or an anonymous request; its token warning is a script limitation, not
a statement about server authentication support.

### Token Authentication

```bash
test -n "${FORGEJO_TOKEN:-}"
curl -fsS --max-time 15 \
  -H "Authorization: token $FORGEJO_TOKEN" \
  "$FORGEJO_SERVER_URL/api/v1/user" \
  | jq '{login,is_admin,active}'
```

Use a token with the smallest repository permissions that cover the intended
operation. Do not put the token in a remote URL, shell history, committed env
file, operation record, or issue/PR body.

### Git Keychain Basic Authentication

Use this fallback only on a trusted local machine with the expected `origin`.

```bash
FORGEJO_CREDENTIAL=$(printf 'url=%s\n\n' "$FORGEJO_REMOTE_URL" | git credential fill)
FORGEJO_USER=$(printf '%s\n' "$FORGEJO_CREDENTIAL" | sed -n 's/^username=//p' | head -n 1)
FORGEJO_PASSWORD=$(printf '%s\n' "$FORGEJO_CREDENTIAL" | sed -n 's/^password=//p' | head -n 1)

test -n "$FORGEJO_USER"
test -n "$FORGEJO_PASSWORD"
curl -fsS --max-time 15 \
  --user "$FORGEJO_USER:$FORGEJO_PASSWORD" \
  "$FORGEJO_SERVER_URL/api/v1/user" \
  | jq '{login,is_admin,active}'
```

The expanded Basic Auth argument can be visible briefly to local process
inspection. Prefer a scoped token for unattended or repeated automation. At
the end of a Basic Auth operation, clear the variables without printing them:

```bash
unset FORGEJO_CREDENTIAL FORGEJO_USER FORGEJO_PASSWORD
```

## Read-Only Preflight

Run this before creating or changing remote state:

```bash
jj status
jj bookmark list --all-remotes
jj workspace list
git worktree list
jj git fetch --remote origin
git ls-remote --heads origin
```

Then verify the authenticated repository and protection surface with either
authentication method described above:

```bash
curl -fsS --max-time 15 \
  --user "$FORGEJO_USER:$FORGEJO_PASSWORD" \
  "$FORGEJO_SERVER_URL/api/v1/repos/$FORGEJO_REPOSITORY" \
  | jq '{full_name,private,archived,permissions,default_branch}'

curl -fsS --max-time 15 \
  --user "$FORGEJO_USER:$FORGEJO_PASSWORD" \
  "$FORGEJO_SERVER_URL/api/v1/repos/$FORGEJO_REPOSITORY/branch_protections" \
  | jq '[.[] | {branch_name,apply_to_admins,enable_push,enable_status_check,status_check_contexts,block_on_outdated_branch,required_approvals}]'

curl -fsS --max-time 15 \
  --user "$FORGEJO_USER:$FORGEJO_PASSWORD" \
  "$FORGEJO_SERVER_URL/api/v1/repos/$FORGEJO_REPOSITORY/pulls?state=open&limit=50" \
  | jq '[.[] | {number,title,head:.head.ref,head_sha:.head.sha,base:.base.ref,mergeable,has_conflicts}]'
```

Replace `--user ...` with the token header for token-based operation. Never
interpret an anonymous `404` on this private repository as proof that a branch
or PR does not exist; authenticate first.

## Normal Delivery

### 1. Verify And Push The Bookmark

Use the narrowest project check first and run `pnpm run gate` when the change
crosses package boundaries or is ready for delivery.

```bash
pnpm run gate
jj status
jj git fetch --remote origin
jj git push --bookmark <feature-bookmark>
```

Record the full pushed head. Do not rely on the local working-copy change ID as
remote evidence.

```bash
HEAD_SHA=$(git ls-remote origin "refs/heads/<feature-bookmark>" | awk '{print $1}')
test -n "$HEAD_SHA"
printf '%s\n' "$HEAD_SHA"
```

### 2. Create The Forgejo Pull Request

Use the branch name, not an unverified local SHA, as `head`. The following is
the Basic Auth form; token authentication uses the same endpoint and payload.

```bash
jq -n \
  --arg base main \
  --arg head '<feature-bookmark>' \
  --arg title '<type(scope): summary>' \
  --arg body '<checks and residual risk>' \
  '{base:$base,head:$head,title:$title,body:$body}' \
  | curl -fsS --max-time 15 \
      --user "$FORGEJO_USER:$FORGEJO_PASSWORD" \
      -H 'Content-Type: application/json' \
      -X POST \
      --data-binary @- \
      "$FORGEJO_SERVER_URL/api/v1/repos/$FORGEJO_REPOSITORY/pulls" \
  | jq '{number,state,html_url,head_sha:.head.sha,base:.base.ref,mergeable}'
```

After creation, fetch the PR again and require `.head.sha == $HEAD_SHA`. A CI
run for another head, a local gate, or a GitHub run does not satisfy this check.

### 3. Monitor Exact-Head CI

Check both the aggregate commit status and Actions jobs. Keep pending, failed,
cancelled, and success states distinct.

```bash
curl -fsS --max-time 15 \
  --user "$FORGEJO_USER:$FORGEJO_PASSWORD" \
  "$FORGEJO_SERVER_URL/api/v1/repos/$FORGEJO_REPOSITORY/commits/$HEAD_SHA/status" \
  | jq '{state,statuses:[.statuses[] | {context,status,description,target_url}]}'

curl -fsS --max-time 15 \
  --user "$FORGEJO_USER:$FORGEJO_PASSWORD" \
  "$FORGEJO_SERVER_URL/api/v1/repos/$FORGEJO_REPOSITORY/actions/runs?head_sha=$HEAD_SHA&limit=20" \
  | jq '{workflow_runs:[.workflow_runs[] | {id,status,conclusion,event,head_sha,run_number}]}'
```

Do not merge while a required context is missing, pending, stale, cancelled, or
failed. A successful Actions run may appear before the commit-status aggregate
finishes propagating; wait and read again rather than bypassing protection.

### 4. Merge Through The API

Immediately before merging, re-read the PR and compare the exact head. Do not
reuse an old response after the branch has changed.

```bash
PR_NUMBER=<forgejo-pr-number>

curl -fsS --max-time 15 \
  --user "$FORGEJO_USER:$FORGEJO_PASSWORD" \
  "$FORGEJO_SERVER_URL/api/v1/repos/$FORGEJO_REPOSITORY/pulls/$PR_NUMBER" \
  | jq '{number,state,merged,mergeable,head_sha:.head.sha,base_sha:.base.sha}'

jq -n \
  --arg head "$HEAD_SHA" \
  '{Do:"merge",head_commit_id:$head,delete_branch_after_merge:false,force_merge:false}' \
  | curl -fsS --max-time 30 \
      --user "$FORGEJO_USER:$FORGEJO_PASSWORD" \
      -H 'Content-Type: application/json' \
      -X POST \
      --data-binary @- \
      "$FORGEJO_SERVER_URL/api/v1/repos/$FORGEJO_REPOSITORY/pulls/$PR_NUMBER/merge"
```

Keep `force_merge:false`. Deleting the feature branch is a separate closeout
decision so absorption and operator consent can be verified first.

### 5. Verify And Close Out

```bash
jj git fetch --remote origin
jj log -r 'main@origin' -n 1
git merge-base --is-ancestor "$HEAD_SHA" refs/remotes/origin/main
bash tools/branch-prune-origin.sh
```

`branch-prune-origin.sh` is dry-run by default. Use `--apply` only after the
operator approves remote deletion. Report the PR number, exact head, merge
commit, required checks, dirty paths, bookmark state, checks not run, and any
remaining risk.

## GitHub-To-Forgejo Reconciliation

When GitHub contains approved patches that Forgejo `main` does not yet contain:

1. Fetch both remotes and compare full heads and patch content.
2. Create a short-lived `sync/` or `integration/` bookmark from the reviewed
   GitHub head.
3. Push that bookmark to Forgejo.
4. Create a Forgejo PR from the sync bookmark to `main`.
5. Require Forgejo exact-head checks and merge through the protected PR path.
6. Only after Forgejo `main` absorbs the patches, prune the sync and absorbed
   feature branches with explicit approval.

Do not merge locally and push `main`, disable protection, or force-update
Forgejo to make the graphs look alike. Patch content and protected merge
evidence matter more than identical merge topology.

## Forgejo-To-GitHub Mirror

GitHub is independent validation. When histories diverge, create an equivalent
patch PR against `github/main`; do not push Forgejo merge topology over
protected GitHub `main`. Use `docs/operations/github-mirror-recovery.md` only
for the exceptional, separately approved repair procedure described there.

GitHub authentication, PR state, Actions, branch protection, quota, and API
health remain separate from Forgejo. `gh auth status` proves local GitHub
authentication, not current API reachability or successful mirroring.

## Common Failure Interpretation

| Observation | Meaning | Next check |
| --- | --- | --- |
| `/api/v1/version` returns `200` | Forgejo/API is reachable | Authenticate and read the repository |
| Private repo endpoint returns anonymous `404` | The repo may be hidden from anonymous callers | Retry with supported authentication |
| Authenticated `/api/v1/user` returns `401` | Credential rejected or second factor required | Verify Keychain/token and `X-FORGEJO-OTP` requirements |
| Authenticated repo returns `403` | Account or token lacks permission | Read repo permissions; do not bypass protection |
| PR create returns `409` or `422` | Conflict, duplicate PR, stale/missing branch, or invalid payload | List open PRs and read both branch heads |
| Merge request is rejected while jobs are green | Commit-status aggregation may still be pending or the head changed | Re-read PR head, protection contexts, and aggregate status |
| `FORGEJO_TOKEN` is unset | Token auth unavailable in this shell | Use approved Keychain Basic Auth or provision a scoped token |
| `branch-closeout.sh` warns about token | Its remote CI query cannot authenticate | Verify via authenticated API; do not infer server limitation |
| Git push succeeds but API is anonymous | Git credential path works; the current API call did not use it | Load Keychain Basic Auth or a token explicitly |
| GitHub API fails while Git refs resolve | API health and Git transport differ | Report the API gap; do not infer PR state from refs alone |

## References

- `docs/governance/forgejo-branch-gates.md`
- `docs/governance/branch-lifecycle.md`
- `docs/governance/github-branch-gates.md`
- `docs/operations/github-mirror-recovery.md`
- `tools/branch-closeout.sh`
- `tools/branch-prune-origin.sh`
