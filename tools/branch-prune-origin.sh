#!/usr/bin/env bash
# Prune merged/absorbed origin feature branches (post-integration closeout).
# Default: dry-run. Pass --apply to run git push origin --delete.
set -euo pipefail

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then
  APPLY=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

git fetch origin --prune

DELETE=()
REVIEW=()

while IFS= read -r branch; do
  [[ -z "$branch" ]] && continue
  short="${branch#origin/}"
  [[ "$short" == "main" || "$short" == "HEAD" || "$short" == "origin" || "$branch" == "origin" ]] && continue

  counts=$(git rev-list --left-right --count "origin/main...origin/$short" 2>/dev/null || echo "0 0")
  behind=$(echo "$counts" | awk '{print $1}')
  ahead=$(echo "$counts" | awk '{print $2}')

  cherry_out=$(git cherry origin/main "origin/$short" 2>/dev/null || true)
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
done < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin)

echo "=== origin branch prune (apply=$APPLY) ==="
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
  echo "Deleting origin/$short ..."
  git push origin --delete "$short"
done

echo "Done. Local tracking refs: git fetch origin --prune"