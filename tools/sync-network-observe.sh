#!/bin/bash
# sync-network-observe.sh
# Bridge aidebug network-observe outputs into the los workspace so los
# scheduled agents can analyze them (los agent sandbox cannot read paths
# outside its workspace root).
#
# Pulls the newest N reports + snapshots (same retention window as
# network-observe.mjs) from:
#   /Users/echerlos/Downloads/projects/aidebug/.network-observe/
# into:
#   <los workspace>/.los-runtime/network-observe/input/
# and writes bridge-manifest.json with sync metadata.
#
# Read-only with respect to the source; only writes into the los workspace.
set -euo pipefail

SRC_ROOT="/Users/echerlos/Downloads/projects/aidebug/.network-observe"
DST_ROOT="$(cd "$(dirname "$0")/.." && pwd)/.los-runtime/network-observe"
DST_INPUT="$DST_ROOT/input"
KEEP=14   # match network-observe.mjs retention window (14 days)

if [ ! -d "$SRC_ROOT/reports" ] || [ ! -d "$SRC_ROOT/snapshots" ]; then
  echo "error: source dirs missing under $SRC_ROOT" >&2
  exit 1
fi

mkdir -p "$DST_INPUT"

# Copy newest KEEP reports and snapshots by filename timestamp (ISO sortable).
ls -1 "$SRC_ROOT/reports"/*.md 2>/dev/null | sort -r | head -n "$KEEP" | while read -r f; do
  cp -f "$f" "$DST_INPUT/"
done
ls -1 "$SRC_ROOT/snapshots"/*.json 2>/dev/null | sort -r | head -n "$KEEP" | while read -r f; do
  cp -f "$f" "$DST_INPUT/"
done

# Defensive cleanup of stale files in DST beyond KEEP.
ls -1 "$DST_INPUT"/*.md 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done || true
ls -1 "$DST_INPUT"/*.json 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done || true

LATEST_REPORT=$(ls -1 "$DST_INPUT"/*.md 2>/dev/null | sort -r | head -n 1 | xargs -n1 basename 2>/dev/null || echo "")
LATEST_SNAPSHOT=$(ls -1 "$DST_INPUT"/*.json 2>/dev/null | sort -r | head -n 1 | xargs -n1 basename 2>/dev/null || echo "")
REPORT_COUNT=$(ls -1 "$DST_INPUT"/*.md 2>/dev/null | wc -l | tr -d ' ')
SNAPSHOT_COUNT=$(ls -1 "$DST_INPUT"/*.json 2>/dev/null | wc -l | tr -d ' ')

# ── Surge log error window (2h, matching the 1500/4000 per-hour thresholds) ──
SURGE_DIR="$DST_ROOT/surge-input"
mkdir -p "$SURGE_DIR"
SURGE_TS=$(date -u +%Y-%m-%dT%H-%M-%S)
NODE_BIN="/Users/echerlos/Library/Application Support/fnm/aliases/default/bin/node"
if [ -x "$NODE_BIN" ] && "$NODE_BIN" /Users/echerlos/Downloads/projects/aidebug/scripts/surge-ai-window.mjs --minutes 120 --json > "$SURGE_DIR/surge-errors-$SURGE_TS.json" 2>/dev/null; then
  # keep newest 24 surge windows
  ls -1 "$SURGE_DIR"/surge-errors-*.json 2>/dev/null | sort -r | tail -n +25 | while read -r f; do rm -f "$f"; done || true
  SURGE_WINDOWS=$(ls -1 "$SURGE_DIR"/surge-errors-*.json 2>/dev/null | wc -l | tr -d ' ')
else
  SURGE_WINDOWS=0
  echo "warning: surge-ai-window capture failed (Surge may be off)" >&2
fi

cat > "$DST_ROOT/bridge-manifest.json" <<EOF
{
  "syncedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "$SRC_ROOT",
  "keep": $KEEP,
  "reportCount": $REPORT_COUNT,
  "snapshotCount": $SNAPSHOT_COUNT,
  "surgeWindowCount": $SURGE_WINDOWS,
  "latestReport": "$LATEST_REPORT",
  "latestSnapshot": "$LATEST_SNAPSHOT"
}
EOF

echo "bridged $REPORT_COUNT reports, $SNAPSHOT_COUNT snapshots, $SURGE_WINDOWS surge windows -> $DST_ROOT"
