#!/usr/bin/env bash
# Prune merged/absorbed feature branches from the configured primary remote.
# Default: dry-run. Pass --apply to delete remote branches.
set -euo pipefail

PRIMARY_REMOTE="${LOS_BRANCH_GOVERNANCE_PRIMARY_REMOTE:-origin}"
if [[ ! "$PRIMARY_REMOTE" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid primary remote: $PRIMARY_REMOTE" >&2
  exit 2
fi

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then
  APPLY=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

git fetch "$PRIMARY_REMOTE" --prune

DELETE=()
REVIEW=()

while IFS= read -r branch; do
  [[ -z "$branch" ]] && continue
  short="${branch#${PRIMARY_REMOTE}/}"
  [[ "$short" == "main" || "$short" == "HEAD" || "$short" == "$PRIMARY_REMOTE" || "$branch" == "$PRIMARY_REMOTE" ]] && continue

  counts=$(git rev-list --left-right --count "$PRIMARY_REMOTE/main...$PRIMARY_REMOTE/$short" 2>/dev/null || echo "0 0")
  behind=$(echo "$counts" | awk '{print $1}')
  ahead=$(echo "$counts" | awk '{print $2}')

  cherry_out=$(git cherry "$PRIMARY_REMOTE/main" "$PRIMARY_REMOTE/$short" 2>/dev/null || true)
  plus=$(echo "$cherry_out" | grep -c '^+' || true)
  cherry_lines=$(echo "$cherry_out" | grep -c . || true)
  all_absorbed=0
  if [[ "$cherry_lines" -gt 0 && "$plus" -eq 0 ]]; then
    all_absorbed=1
  fi

  if [[ "$ahead" == "0" ]]; then
    DELETE+=("$short")
  elif [[ "$all_absorbed" -eq 1 ]]; then
    DELETE+=("$short")
  else
    REVIEW+=("$short (ahead=$ahead behind=$behind cherry+=$plus)")
  fi
done < <(git for-each-ref --format='%(refname:short)' "refs/remotes/$PRIMARY_REMOTE")

echo "=== $PRIMARY_REMOTE branch prune (apply=$APPLY) ==="
if ((${#DELETE[@]})); then
  echo "Will delete (${#DELETE[@]}):"
  printf '  %s\n' "${DELETE[@]}"
else
  echo "Nothing classified as safe delete."
fi

if ((${#REVIEW[@]})); then
  echo "Needs review (${#REVIEW[@]}):"
  printf '  %s\n' "${REVIEW[@]}"
fi

if [[ "$APPLY" -eq 0 ]]; then
  echo ""
  echo "Dry-run only. Re-run with: $0 --apply"
  exit 0
fi

for short in "${DELETE[@]}"; do
  echo "Deleting $PRIMARY_REMOTE/$short ..."
  git push "$PRIMARY_REMOTE" --delete "$short"
done

echo "Done. Local tracking refs: git fetch $PRIMARY_REMOTE --prune"
