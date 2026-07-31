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
  local json state rollup_len pending failed attempts=0
  # ~20s * 45 ~= 15 minutes upper bound (GitHub green path is ~2.5–4m).
  local max_attempts="${LOS_MIRROR_MAX_ATTEMPTS:-45}"

  info "Waiting for PR #${pr} checks..."
  info "  required: ${REQUIRED_CHECKS[*]}"
  info "  poll interval: ${CHECK_INTERVAL}s (max attempts ${max_attempts})"
  info "  success requires non-empty statusCheckRollup + required contexts green"
  info "  note: gh pr checks --watch can exit early while status=QUEUED; we poll JSON instead"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] poll gh pr view --json statusCheckRollup,mergeStateStatus"
    return 0
  fi

  while true; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -gt "$max_attempts" ]]; then
      die "timed out waiting for PR #${pr} checks after ${max_attempts} attempts"
    fi

    json="$(pr_json "$pr")"
    state="$(printf '%s' "$json" | jq -er '.mergeStateStatus')" \
      || die "mergeStateStatus missing from PR JSON"
    rollup_len="$(printf '%s' "$json" | jq -er '(.statusCheckRollup // []) | length')" \
      || die "statusCheckRollup missing from PR JSON"

    if [[ "$rollup_len" -eq 0 ]]; then
      info "  $(date '+%H:%M:%S') attempt=${attempts} mergeStateStatus=${state} rollup=[] (scheduling)"
      sleep "$CHECK_INTERVAL"
      continue
    fi

    pending="$(printf '%s' "$json" | jq -r '
      [.statusCheckRollup[]?
        | select((.status // "") != "COMPLETED")
      ] | length
    ')"
    failed="$(printf '%s' "$json" | jq -r '
      [.statusCheckRollup[]?
        | select((.status // "") == "COMPLETED")
        | select((.conclusion // "") as $c
            | ($c != "SUCCESS" and $c != "NEUTRAL" and $c != "SKIPPED" and $c != ""))
      ] | length
    ')"

    info "  $(date '+%H:%M:%S') attempt=${attempts} mergeStateStatus=${state} pending=${pending} failed=${failed} rollup=${rollup_len}"
    printf '%s' "$json" | jq -r '
      .statusCheckRollup[]?
      | "    " + (.name // .context // "?")
        + " status=" + (.status // "?")
        + " conclusion=" + (.conclusion // "null")
    ' || true

    if [[ "$failed" -gt 0 ]]; then
      red "PR #${pr} has failing checks — refuse to merge"
      printf '%s\n' "$json" | jq '{mergeStateStatus, checks: [.statusCheckRollup[]? | {name, status, conclusion}]}'
      exit 1
    fi

    if [[ "$pending" -eq 0 ]]; then
      # All completed; require required contexts green. mergeStateStatus may be
      # BEHIND on mirror PRs (divergent histories) — that is OK for merge commits.
      assert_required_checks_green "$json"
      case "$state" in
        CLEAN|HAS_HOOKS|BEHIND|BLOCKED|UNSTABLE)
          # BLOCKED/UNSTABLE with all required green usually means non-required
          # or review rules; re-check after a short wait once, then allow merge
          # only for CLEAN/HAS_HOOKS/BEHIND (mirror typical).
          if [[ "$state" == "CLEAN" || "$state" == "HAS_HOOKS" || "$state" == "BEHIND" ]]; then
            green "PR #${pr} ready (mergeStateStatus=${state}, required checks green)"
            return 0
          fi
          info "  required green but mergeStateStatus=${state}; waiting..."
          ;;
        *)
          info "  required green but mergeStateStatus=${state}; waiting..."
          ;;
      esac
    fi

    sleep "$CHECK_INTERVAL"
  done
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
  # Mirror histories diverge, so BEHIND is expected and still mergeable with a
  # merge commit. Only refuse hard blockers.
  case "$state" in
    CLEAN|HAS_HOOKS|BEHIND) ;;
    DIRTY|DRAFT|UNKNOWN)
      die "refuse merge: PR #${pr} mergeStateStatus=${state}"
      ;;
    *)
      info "mergeStateStatus=${state}; attempting merge commit anyway (required checks green)"
      ;;
  esac
  info "Merging PR #${pr} with merge commit (no squash/rebase)..."
  gh pr merge "$pr" --merge --delete-branch=false
  green "Merged PR #${pr}"
}

bookmark_exists() {
  # Exact local bookmark name only. Do NOT grep --all output: descriptions of
  # prior mirror merges mention the branch name and caused false positives
  # (move skipped, push no-op, gh pr create: no commits between main and head).
  jj bookmark list -T 'name ++ "\n"' 2>/dev/null | grep -Fxq "$BOOKMARK"
}

ensure_mirror_bookmark() {
  if bookmark_exists; then
    info "Moving existing bookmark ${BOOKMARK} -> main@${ORIGIN_REMOTE}"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] jj bookmark move ${BOOKMARK} --to main@${ORIGIN_REMOTE}"
      return 0
    fi
    jj bookmark move "$BOOKMARK" --to "main@${ORIGIN_REMOTE}"
  else
    info "Creating bookmark ${BOOKMARK} -> main@${ORIGIN_REMOTE}"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] jj bookmark create ${BOOKMARK} --to main@${ORIGIN_REMOTE}"
      return 0
    fi
    jj bookmark create "$BOOKMARK" --to "main@${ORIGIN_REMOTE}"
  fi
  bookmark_exists || die "failed to create/move bookmark ${BOOKMARK}"
}

cleanup_mirror_ref() {
  info "Cleaning mirror bookmark/branch '${BOOKMARK}'..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] git push ${GITHUB_REMOTE} --delete ${BOOKMARK}"
    info "[dry-run] jj bookmark delete ${BOOKMARK}"
    return 0
  fi
  # --no-verify: branch deletion must not run the pre-push `pnpm gate` hook
  # (observed ~80s waste on every successful mirror cleanup).
  git push --no-verify "$GITHUB_REMOTE" --delete "$BOOKMARK" 2>/dev/null || true
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

ensure_mirror_bookmark

info "Pushing ${BOOKMARK} to ${GITHUB_REMOTE}..."
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "[dry-run] jj git push --remote ${GITHUB_REMOTE} --bookmark ${BOOKMARK}"
else
  # Fail hard if the bookmark is missing after ensure (guards the false-positive
  # "Nothing changed" path that left gh pr create with an empty head).
  bookmark_exists || die "bookmark ${BOOKMARK} missing before push"
  jj git push --remote "$GITHUB_REMOTE" --bookmark "$BOOKMARK" \
    || die "jj git push of ${BOOKMARK} to ${GITHUB_REMOTE} failed"
fi

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
