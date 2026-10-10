#!/usr/bin/env bash
# update-large-file-baseline.sh — compact tools/.large-file-baseline.txt.
#
# The baseline is the ratchet floor for `tools/check-structure.sh` section 2:
# a file with BLOCK_LINES < lines <= MAX_LINES is a WARN only while it is listed;
# unlisted files in that range are ERRORs. Entries for files that have since been
# slimmed below BLOCK_LINES (or deleted) are dead weight: they keep the floor high
# and make the "ratchet must not grow" check meaningless.
#
# This script regenerates the baseline with the SAME selection rules as
# check-structure.sh (packages/**, *.ts|*.tsx, no node_modules/dist/test/*.test.*).
#
# Ratchet-safe by default: it only REMOVES stale entries. Newly grandfathering a
# file (adding an entry) weakens the gate, so it requires an explicit --allow-add.
#
# Usage:
#   ./tools/update-large-file-baseline.sh --dry-run      # show adds/removes only
#   ./tools/update-large-file-baseline.sh                # compact (removals only)
#   ./tools/update-large-file-baseline.sh --allow-add    # also grandfather new files
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE_FILE="$ROOT/tools/.large-file-baseline.txt"
BLOCK_LINES=500
MAX_LINES=700

DRY_RUN=0
ALLOW_ADD=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-add) ALLOW_ADD=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Usage: $0 [--dry-run] [--allow-add]" >&2; exit 2 ;;
  esac
done

# Current grandfathered set — mirrors check-structure.sh section 2 exactly.
current="$(mktemp)"
baseline_sorted="$(mktemp)"
trap 'rm -f "$current" "$baseline_sorted"' EXIT
find "$ROOT/packages" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -path '*/node_modules/*' ! -path '*/dist/*' \
  ! -path '*/test/*' ! -name '*.test.*' \
  -exec wc -l {} + 2>/dev/null \
  | awk -v min="$BLOCK_LINES" -v max="$MAX_LINES" \
      '$2 != "total" && $1 > min && $1 <= max { print $2 }' \
  | sed "s#^$ROOT/##" \
  | LC_ALL=C sort > "$current"

[ -f "$BASELINE_FILE" ] || : > "$BASELINE_FILE"
LC_ALL=C sort "$BASELINE_FILE" > "$baseline_sorted"

added="$(comm -13 "$baseline_sorted" "$current")"
removed="$(comm -23 "$baseline_sorted" "$current")"

before=$(wc -l < "$BASELINE_FILE" | tr -d ' ')
after=$(wc -l < "$current" | tr -d ' ')

echo "=== large-file baseline (BLOCK=$BLOCK_LINES, MAX=$MAX_LINES) ==="
echo "entries: $before -> $after"

if [ -n "$removed" ]; then
  echo "remove ($(echo "$removed" | wc -l | tr -d ' ')) — no longer over $BLOCK_LINES lines:"
  echo "$removed" | sed 's/^/  - /'
else
  echo "remove: none (baseline has no stale entries)"
fi

if [ -n "$added" ]; then
  echo "add ($(echo "$added" | wc -l | tr -d ' ')) — newly over $BLOCK_LINES lines:"
  echo "$added" | sed 's/^/  + /'
  if [ "$ALLOW_ADD" -eq 0 ]; then
    echo "" >&2
    echo "Refusing to grandfather new files: that grows the ratchet floor." >&2
    echo "Slim the file below $BLOCK_LINES lines, or re-run with --allow-add to record the decision." >&2
    exit 1
  fi
else
  echo "add: none"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "dry-run: $BASELINE_FILE unchanged"
  exit 0
fi

cp "$current" "$BASELINE_FILE"
echo ""
echo "wrote $BASELINE_FILE ($after entries)"
echo "verify: bash tools/check-structure.sh"
