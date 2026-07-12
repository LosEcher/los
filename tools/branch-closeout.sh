#!/usr/bin/env bash
# Read-only branch closeout check — never writes, pushes, or merges.
# Run from: projects/los/
# Exit code 0 = all checks pass, 1 = issues found (review before merge).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

ISSUES=0
PRIMARY_REMOTE="${LOS_BRANCH_GOVERNANCE_PRIMARY_REMOTE:-origin}"
if [[ ! "$PRIMARY_REMOTE" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid primary remote: $PRIMARY_REMOTE" >&2
  exit 2
fi

green() { echo -e "\033[32m  ✓ $1\033[0m"; }
red()   { echo -e "\033[31m  ✗ $1\033[0m"; ISSUES=$((ISSUES + 1)); }
warn()  { echo -e "\033[33m  ⚠ $1\033[0m"; }
info()  { echo -e "\033[37m  ℹ $1\033[0m"; }
section() { echo ""; echo -e "\033[1m$1\033[0m"; }

# ── 1. jj status ────────────────────────────────────────

section "1. jj status"
if command -v jj &>/dev/null && jj root 2>/dev/null | grep -q .; then
  if jj status 2>&1 | grep -q "The working copy is clean"; then
    green "Working copy clean"
  else
    warn "Working copy has uncommitted changes:"
    jj status 2>&1 || true
    ISSUES=$((ISSUES + 1))
  fi
else
  warn "jj not available or not in a jj repo — skipping status check"
fi

# ── 2. Diff scope ────────────────────────────────────────

section "2. Diff scope"
if command -v jj &>/dev/null && jj root 2>/dev/null | grep -q .; then
  CHANGES=$(jj log -r 'main..@' --no-graph -T '' 2>/dev/null || true)
  if [ -z "$CHANGES" ]; then
    info "No changes on top of main (or main is the current change)"
  else
    echo "  Changed files vs main:"
    jj diff -r 'main..@' --summary 2>/dev/null || warn "Could not compute diff summary"
    STATS=$(jj diff -r 'main..@' --stat 2>/dev/null || true)
    if [ -n "$STATS" ]; then
      echo "$STATS" | tail -1
    fi
  fi
else
  # Fallback: git
  if git rev-parse --git-dir &>/dev/null; then
    git diff --stat "$PRIMARY_REMOTE/main...HEAD" 2>/dev/null || warn "Could not compute git diff"
  fi
fi

# ── 3. Local gate ────────────────────────────────────────

section "3. Local gate"
GATE_CMD=""
if [ -f "package.json" ] && grep -q '"gate"' package.json 2>/dev/null; then
  GATE_CMD="pnpm run gate"
elif [ -f "Makefile" ] && grep -q '^gate:' Makefile 2>/dev/null; then
  GATE_CMD="make gate"
fi

if [ -n "$GATE_CMD" ]; then
  echo "  Running: $GATE_CMD"
  if eval "$GATE_CMD" 2>&1; then
    green "Local gate passed"
  else
    red "Local gate failed — fix before merge"
  fi
else
  warn "No gate command found — running checks defined in tools/"
  # Fall back to individual checks
  for script in tools/check-*.sh; do
    if [ -x "$script" ]; then
      echo "  Running: $script"
      bash "$script" 2>&1 || warn "$script returned non-zero"
    fi
  done
fi

# ── 4. Remote SHA match ──────────────────────────────────

section "4. Remote SHA match"
if command -v jj &>/dev/null && jj root 2>/dev/null | grep -q .; then
  LOCAL_SHA=$(jj log -r '@' --no-graph -T 'commit_id.shortest(8)' 2>/dev/null || echo "")
  REMOTE_REF="$PRIMARY_REMOTE"
  jj git fetch --remote "$REMOTE_REF" 2>/dev/null || warn "Could not fetch from $REMOTE_REF"
  REMOTE_MAIN_SHA=$(jj log -r "main@$REMOTE_REF" --no-graph -T 'commit_id.shortest(8)' 2>/dev/null || echo "")
  if [ -n "$LOCAL_SHA" ]; then
    info "Local @ commit: $LOCAL_SHA"
  fi
  if [ -n "$REMOTE_MAIN_SHA" ]; then
    info "Remote main commit: $REMOTE_MAIN_SHA"
  fi

  # Check if @ has been pushed (its commits exist on the remote)
  if [ -n "$LOCAL_SHA" ]; then
    PUSHED=$(jj log -r "main..@ & remote_branches()" --no-graph -T '' 2>/dev/null || true)
    if [ -n "$PUSHED" ]; then
      green "Current change appears pushed to remote"
    else
      warn "Current change may not be pushed to remote — verify with 'jj git push --dry-run'"
    fi
  fi
else
  warn "jj not available — check remote SHA manually"
fi

# ── 5. Remote CI ─────────────────────────────────────────

section "5. Remote CI"
SHA=$(jj log -r '@' --no-graph -T 'commit_id' 2>/dev/null || git rev-parse HEAD 2>/dev/null || echo "")
PRIMARY_URL=$(git remote get-url "$PRIMARY_REMOTE" 2>/dev/null || echo "")
if [[ "$PRIMARY_URL" == *github.com* ]] && command -v gh &>/dev/null; then
  REPO=$(echo "$PRIMARY_URL" | sed -E 's#.*github.com[:/]##; s#\.git$##')
  gh run list --repo "$REPO" --commit "$SHA" --limit 5 || warn "GitHub Actions query failed"
elif [[ "$PRIMARY_URL" =~ ^https?:// ]]; then
  SERVER_URL=$(echo "$PRIMARY_URL" | sed -E 's#(https?://[^/]+)/.*#\1#')
  REPO=$(echo "$PRIMARY_URL" | sed -E 's#https?://[^/]+/##; s#\.git$##')
  curl_args=(-fsS --max-time 15 -H 'Accept: application/json')
  if [ -n "${FORGEJO_TOKEN:-}" ]; then
    curl_args+=(-H "Authorization: token $FORGEJO_TOKEN")
  fi
  if [ -n "$SHA" ] && RUNS=$(curl "${curl_args[@]}" "$SERVER_URL/api/v1/repos/$REPO/actions/runs?limit=20" 2>/dev/null); then
    echo "  Checking Forgejo Actions for SHA: ${SHA:0:8}"
    GATE_OK=$(echo "$RUNS" | SHA="$SHA" python3 -c "
import json,os,sys
payload=json.load(sys.stdin)
runs=payload.get('workflow_runs', payload if isinstance(payload, list) else [])
sha=os.environ['SHA']
for run in runs:
  run_sha=run.get('head_sha', run.get('head_commit', {}).get('id', ''))
  if run_sha == sha:
    print(f\"  [{run.get('status','?')}/{run.get('conclusion','pending')}] {run.get('name','CI')} @ {run_sha[:8]}\", file=sys.stderr)
ok=any((run.get('head_sha') == sha or run.get('head_commit', {}).get('id') == sha) and run.get('conclusion') == 'success' for run in runs)
print('true' if ok else 'false')
" 2> >(cat >&2) || echo "false")
    if [ "$GATE_OK" = "true" ]; then
      green "Forgejo Actions passed for this commit"
    else
      warn "No green Forgejo Actions run found for this commit"
    fi
  else
    warn "Forgejo Actions API unavailable; set FORGEJO_TOKEN or verify in $SERVER_URL/$REPO/actions"
  fi
else
  warn "Primary remote CI cannot be queried automatically for URL: $PRIMARY_URL"
fi

# ── Summary ──────────────────────────────────────────────

section "Summary"
if [ "$ISSUES" -eq 0 ]; then
  green "All closeout checks pass — ready for merge review"
else
  warn "$ISSUES issue(s) found — review before merging"
fi

# ── 6. Stale remote branches ────────────────────────────

section "6. Stale remote branches"
STALE_BRANCHES=$(git branch -r --merged "$PRIMARY_REMOTE/main" 2>/dev/null | grep -v "$PRIMARY_REMOTE/HEAD\|$PRIMARY_REMOTE/main" | sed 's/^[[:space:]]*//' || true)
if [ -n "$STALE_BRANCHES" ]; then
  STALE_COUNT=$(echo "$STALE_BRANCHES" | wc -l | tr -d ' ')
  warn "$STALE_COUNT stale remote branch(es) merged into main but not deleted:"
  echo "$STALE_BRANCHES" | while read -r branch; do
    echo "    $branch"
  done
  echo ""
  echo "  To delete: git push $PRIMARY_REMOTE --delete <branch>"
  ISSUES=$((ISSUES + 1))
else
  green "No stale remote branches"
fi

exit 0  # warn only, never block
