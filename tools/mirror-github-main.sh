#!/usr/bin/env bash
# mirror-github-main.sh — automate Forgejo main → GitHub main mirror PR path.
#
# GitHub main is protected by ruleset main-protection with required_status_checks
# enforced on direct push. Forgejo-merged commits have no GitHub Actions records,
# so the only legal path is: push a mirror branch → open PR → wait for green
# checks → merge commit. See SKILL.md "Workflow: GitHub Mirror Sync".
#
# Usage:
#   bash tools/mirror-github-main.sh              # full flow when github lags
#   bash tools/mirror-github-main.sh --dry-run    # print plan, no push/PR/merge
#   bash tools/mirror-github-main.sh --wait-only <PR>
#   bash tools/mirror-github-main.sh --merge-only <PR>
#   bash tools/mirror-github-main.sh --skip-gate  # skip local pnpm gate
#
# Exit codes:
#   0  already in sync, or mirror PR merged and content-equal
#   1  check failure / merge blocked / tooling error
#   2  usage / precondition failure
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BOOKMARK_DEFAULT="mirror/forgejo-main-sync"
BOOKMARK="${LOS_MIRROR_BOOKMARK:-$BOOKMARK_DEFAULT}"
GITHUB_REMOTE="${LOS_MIRROR_GITHUB_REMOTE:-github}"
ORIGIN_REMOTE="${LOS_MIRROR_ORIGIN_REMOTE:-origin}"
CHECK_INTERVAL="${LOS_MIRROR_CHECK_INTERVAL:-20}"
# Required by GitHub ruleset main-protection (gate-web-e2e is visible but not required).
REQUIRED_CHECKS=(gate-fast gate-test gate-drift)

DRY_RUN=0
SKIP_GATE=0
WAIT_ONLY=""
MERGE_ONLY=""

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-gate) SKIP_GATE=1; shift ;;
    --wait-only)
      WAIT_ONLY="${2:-}"
      [[ -n "$WAIT_ONLY" ]] || usage
      shift 2
      ;;
    --merge-only)
      MERGE_ONLY="${2:-}"
      [[ -n "$MERGE_ONLY" ]] || usage
      shift 2
      ;;
    -h|--help) usage ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '%s\n' "$*"; }
die() { red "error: $*"; exit 1; }
die_pre() { red "precondition: $*"; exit 2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die_pre "missing required command: $1"
}

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] $*"
    return 0
  fi
  "$@"
}

require_cmd jj
require_cmd git
require_cmd gh
require_cmd jq

git remote get-url "$GITHUB_REMOTE" >/dev/null 2>&1 \
  || die_pre "git remote '$GITHUB_REMOTE' not configured"
git remote get-url "$ORIGIN_REMOTE" >/dev/null 2>&1 \
  || die_pre "git remote '$ORIGIN_REMOTE' not configured"

# ── reliable PR status helpers ─────────────────────────────────────────────
# Never treat empty jq output as "pending". Empty/null means the query failed
# or the API shape drifted — that is a hard error (the bug that made mirror
# #200 look pending for ~6 minutes after checks were already green).

pr_json() {
  local pr="$1"
  local json
  if ! json="$(gh pr view "$pr" --json number,state,mergeable,mergeStateStatus,statusCheckRollup,url,headRefName)"; then
    die "gh pr view $pr failed"
  fi
  if [[ -z "$json" || "$json" == "null" ]]; then
    die "gh pr view $pr returned empty JSON (do not treat as pending)"
  fi
  printf '%s' "$json"
}

assert_required_checks_green() {
  local json="$1"
  local rollup_len name conclusion status req found

  rollup_len="$(printf '%s' "$json" | jq -er '(.statusCheckRollup // []) | length')" \
    || die "statusCheckRollup missing from PR JSON"
  if [[ "$rollup_len" -eq 0 ]]; then
    die "statusCheckRollup is empty — refuse success/merge (observation bug guard)"
  fi

  # Fail on any unsuccessful completed check that is required, and require
  # every required context to appear with SUCCESS (or NEUTRAL/SKIPPED).
  while IFS=$'\t' read -r name conclusion status; do
    [[ -n "$name" ]] || continue
    case "$conclusion" in
      SUCCESS|NEUTRAL|SKIPPED) ;;
      FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE)
        die "check failed: $name conclusion=$conclusion status=$status"
        ;;
    esac
  done < <(printf '%s' "$json" | jq -r '
    .statusCheckRollup[]?
    | [(.name // .context // "unknown"), (.conclusion // "null"), (.status // "null")]
    | @tsv
  ')

  for req in "${REQUIRED_CHECKS[@]}"; do
    found="$(printf '%s' "$json" | jq -r --arg r "$req" '
      [.statusCheckRollup[]?
        | select((.name // .context // "") == $r)
        | (.conclusion // "null")
      ] | first // empty
    ')"
    if [[ -z "$found" ]]; then
      die "required check not present in rollup: $req"
    fi
    case "$found" in
      SUCCESS|NEUTRAL|SKIPPED) ;;
      *) die "required check not green: $req conclusion=$found" ;;
    esac
  done
}

wait_for_checks() {
  local pr="$1"
  local json state

  info "Waiting for PR #${pr} checks..."
  info "  required: ${REQUIRED_CHECKS[*]}"
  info "  primary watcher: gh pr checks ${pr} --watch --interval ${CHECK_INTERVAL}"
  info "  success requires non-empty statusCheckRollup + required contexts green"

  # gh pr checks --watch returns when all reported checks complete. It is the
  # platform-native waiter; we still re-validate via JSON before treating the
  # PR as mergeable (guards empty jq / incomplete rollup).
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] gh pr checks $pr --watch --interval $CHECK_INTERVAL"
    return 0
  fi

  if ! gh pr checks "$pr" --watch --interval "$CHECK_INTERVAL"; then
    json="$(pr_json "$pr" || true)"
    red "gh pr checks --watch reported failure for PR #$pr"
    if [[ -n "${json:-}" ]]; then
      printf '%s\n' "$json" | jq '{mergeStateStatus, checks: [.statusCheckRollup[]? | {name, status, conclusion}]}' || true
    fi
    exit 1
  fi

  json="$(pr_json "$pr")"
  state="$(printf '%s' "$json" | jq -er '.mergeStateStatus')" \
    || die "mergeStateStatus missing from PR JSON"
  info "  mergeStateStatus=$state after checks watch"
  assert_required_checks_green "$json"

  # Poll briefly if mergeability lags behind check completion.
  local attempts=0
  while [[ "$state" != "CLEAN" && "$state" != "HAS_HOOKS" ]]; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -gt 30 ]]; then
      die "PR #$pr checks green but mergeStateStatus stayed $state"
    fi
    info "  waiting for mergeStateStatus=CLEAN (now ${state})..."
    sleep "$CHECK_INTERVAL"
    json="$(pr_json "$pr")"
    state="$(printf '%s' "$json" | jq -er '.mergeStateStatus')"
    assert_required_checks_green "$json"
  done

  green "PR #$pr ready (mergeStateStatus=$state, required checks green)"
}

merge_pr() {
  local pr="$1"
  local json state

  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] gh pr merge $pr --merge --delete-branch=false"
    return 0
  fi

  json="$(pr_json "$pr")"
  state="$(printf '%s' "$json" | jq -er '.mergeStateStatus')"
  assert_required_checks_green "$json"
  if [[ "$state" != "CLEAN" && "$state" != "HAS_HOOKS" ]]; then
    die "refuse merge: PR #$pr mergeStateStatus=$state (want CLEAN)"
  fi
  info "Merging PR #${pr} with merge commit (no squash/rebase)..."
  gh pr merge "$pr" --merge --delete-branch=false
  green "Merged PR #${pr}"
}

bookmark_exists() {
  jj bookmark list --all 2>/dev/null | grep -F "$BOOKMARK" >/dev/null 2>&1
}

cleanup_mirror_ref() {
  info "Cleaning mirror bookmark/branch '${BOOKMARK}'..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] git push ${GITHUB_REMOTE} --delete ${BOOKMARK}"
    info "[dry-run] jj bookmark delete ${BOOKMARK}"
    return 0
  fi
  git push "$GITHUB_REMOTE" --delete "$BOOKMARK" 2>/dev/null || true
  if bookmark_exists; then
    jj bookmark delete "$BOOKMARK" 2>/dev/null || true
  fi
}

content_diff_empty() {
  # True when forgejo main and github main have identical file trees.
  local stat
  stat="$(jj diff --from "main@${ORIGIN_REMOTE}" --to "main@${GITHUB_REMOTE}" --stat 2>/dev/null || true)"
  if [[ -z "$stat" ]]; then
    return 0
  fi
  if printf '%s\n' "$stat" | grep -q '0 files changed'; then
    return 0
  fi
  return 1
}

verify_content_equal() {
  info "Fetching remotes and verifying content equality..."
  run jj git fetch --remote "$ORIGIN_REMOTE"
  run jj git fetch --remote "$GITHUB_REMOTE"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] jj diff --from main@${ORIGIN_REMOTE} --to main@${GITHUB_REMOTE} --stat"
    return 0
  fi
  if content_diff_empty; then
    green "Content equal: main@${ORIGIN_REMOTE} == main@${GITHUB_REMOTE}"
    return 0
  fi
  red "Content still differs after mirror:"
  jj diff --from "main@${ORIGIN_REMOTE}" --to "main@${GITHUB_REMOTE}" --stat || true
  exit 1
}

realign_local_main() {
  # Keep local main on Forgejo authority (mirror merge may advance github main).
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] jj bookmark move main --to main@${ORIGIN_REMOTE}"
    return 0
  fi
  jj bookmark move main --to "main@${ORIGIN_REMOTE}" --allow-backwards 2>/dev/null \
    || jj bookmark move main --to "main@${ORIGIN_REMOTE}" 2>/dev/null \
    || true
}

# ── subcommands ────────────────────────────────────────────────────────────

if [[ -n "$WAIT_ONLY" ]]; then
  wait_for_checks "$WAIT_ONLY"
  exit 0
fi

if [[ -n "$MERGE_ONLY" ]]; then
  wait_for_checks "$MERGE_ONLY"
  merge_pr "$MERGE_ONLY"
  cleanup_mirror_ref
  verify_content_equal
  realign_local_main
  exit 0
fi

# ── full flow ──────────────────────────────────────────────────────────────

info "=== GitHub mirror sync (Forgejo → GitHub) ==="
info "origin=$ORIGIN_REMOTE  github=$GITHUB_REMOTE  bookmark=$BOOKMARK"

info "Fetching remotes..."
run jj git fetch --remote "$ORIGIN_REMOTE"
run jj git fetch --remote "$GITHUB_REMOTE"

ORIGIN_MAIN="$(jj log -r "main@${ORIGIN_REMOTE}" --no-graph -T 'commit_id' -n 1 2>/dev/null | head -1)"
GITHUB_MAIN="$(jj log -r "main@${GITHUB_REMOTE}" --no-graph -T 'commit_id' -n 1 2>/dev/null | head -1)"
[[ -n "$ORIGIN_MAIN" ]] || die_pre "cannot resolve main@${ORIGIN_REMOTE}"
[[ -n "$GITHUB_MAIN" ]] || die_pre "cannot resolve main@${GITHUB_REMOTE}"

info "main@${ORIGIN_REMOTE}=${ORIGIN_MAIN:0:12}"
info "main@${GITHUB_REMOTE}=${GITHUB_MAIN:0:12}"

if content_diff_empty; then
  green "Already in sync (empty content diff). Nothing to do."
  exit 0
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] content differs; would push/PR/merge"
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  jj bookmark move main --to "main@${ORIGIN_REMOTE}" 2>/dev/null || true
fi

if [[ "$SKIP_GATE" -eq 0 ]]; then
  info "Running local gate --no-tests (Forgejo already validated full CI on this tree)..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] pnpm run gate -- --no-tests"
  else
    # jj git push does not run the git pre-push hook.
    pnpm run gate -- --no-tests
  fi
else
  info "Skipping local gate (--skip-gate)"
fi

if bookmark_exists; then
  info "Moving existing bookmark ${BOOKMARK} -> main@${ORIGIN_REMOTE}"
  run jj bookmark move "$BOOKMARK" --to "main@${ORIGIN_REMOTE}"
else
  info "Creating bookmark ${BOOKMARK} -> main@${ORIGIN_REMOTE}"
  run jj bookmark create "$BOOKMARK" --to "main@${ORIGIN_REMOTE}"
fi

info "Pushing ${BOOKMARK} to ${GITHUB_REMOTE}..."
run jj git push --remote "$GITHUB_REMOTE" --bookmark "$BOOKMARK"

EXISTING_PR=""
if [[ "$DRY_RUN" -eq 0 ]]; then
  EXISTING_PR="$(gh pr list --repo LosEcher/los --base main --head "$BOOKMARK" --state open --json number --jq '.[0].number // empty' 2>/dev/null || true)"
fi

if [[ -n "$EXISTING_PR" ]]; then
  info "Reusing open PR #${EXISTING_PR}"
  PR_NUM="$EXISTING_PR"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] gh pr create --base main --head ${BOOKMARK} ..."
  PR_NUM="DRY"
else
  BEHIND_HINT="$(jj log -r "main@${GITHUB_REMOTE}..main@${ORIGIN_REMOTE}" --no-graph -T 'commit_id.short() ++ "\n"' 2>/dev/null | grep -c . || true)"
  PR_URL="$(gh pr create --base main --head "$BOOKMARK" \
    --title "mirror: sync Forgejo main -> GitHub (${BEHIND_HINT:-n} commits)" \
    --body "$(cat <<EOF
Mirror sync from Forgejo (authoritative).

- Forgejo \`main\`: \`${ORIGIN_MAIN:0:12}\`
- Direct push blocked by ruleset \`main-protection\` (required_status_checks on push).
- Automated by \`tools/mirror-github-main.sh\`.

Do not squash/rebase — merge commit only.
EOF
)")"
  PR_NUM="$(printf '%s\n' "$PR_URL" | grep -oE '[0-9]+$' || true)"
  [[ -n "$PR_NUM" ]] || die "could not parse PR number from: $PR_URL"
  green "Opened PR #${PR_NUM} — ${PR_URL}"
fi

if [[ "$PR_NUM" == "DRY" ]]; then
  info "[dry-run] would wait for checks and merge"
  exit 0
fi

wait_for_checks "$PR_NUM"
merge_pr "$PR_NUM"
cleanup_mirror_ref
verify_content_equal
realign_local_main

green "Mirror sync complete."
