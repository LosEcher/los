#!/usr/bin/env bash
# node-audit.sh — read-only inventory of toolchain, services and los runtime
# across the los mesh nodes. No writes on remote nodes. Safe to run anytime.
#
# Usage:
#   tools/node-audit.sh                        # audit all configured nodes
#   tools/node-audit.sh oracle-t vultr-r-t     # audit specific SSH aliases
#   tools/node-audit.sh --local                # audit only this machine (mbp)
#   tools/node-audit.sh --help
#
# Node inventory is derived from ~/.ssh/config aliases (see NODES below).
# Results: one .txt per node under .los-runtime/audit-logs/<ts>/, plus a
# one-line summary per node on stdout.
#
# Reference baseline: docs/operations/2026-08-02-node-toolchain-audit.md
set -uo pipefail

# ── Node inventory (SSH aliases from ~/.ssh/config; "local" = this machine) ──
# los executor nodes: local (mbp), oracle-t, localnode34-r-t
# mesh nodes: vultr-r-t, hh-sgp1-r-t, tencent-sin-t, nas-t, glkvm
NODES=(local oracle-t localnode34-r-t vultr-r-t hh-sgp1-r-t tencent-sin-t nas-t glkvm)

AUDIT_DIR=".los-runtime/audit-logs"
REMOTE_SCRIPT="$(cd "$(dirname "$0")" && pwd)/node-audit-remote.sh"
TS="$(date +%Y%m%d-%H%M%S)"

log()  { printf '[audit] %s\n' "$*"; }

# ── Local audit (mbp) ──────────────────────────────────────────────────────
audit_local() {
  bash "$REMOTE_SCRIPT"
}

# ── Remote audit ───────────────────────────────────────────────────────────
audit_remote() {
  local alias="$1"
  local out="$2"
  ssh -o ConnectTimeout=8 -o BatchMode=yes "$alias" 'bash -s' < "$REMOTE_SCRIPT" > "$out" 2>&1
}

# ── Main ───────────────────────────────────────────────────────────────────
SELECTED=()
LOCAL_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL_ONLY=true ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) SELECTED+=("$arg") ;;
  esac
done

if [ "${#SELECTED[@]}" -gt 0 ]; then
  NODES=("${SELECTED[@]}")
elif $LOCAL_ONLY; then
  NODES=(local)
fi

mkdir -p "$AUDIT_DIR/$TS"

echo "=== los node audit @ $TS ==="
for node in "${NODES[@]}"; do
  out="$AUDIT_DIR/$TS/$node.txt"
  if [ "$node" = "local" ]; then
    audit_local > "$out" 2>&1
  else
    log "auditing $node (ssh alias) ..."
    audit_remote "$node" "$out"
    if [ ! -s "$out" ] || ! grep -q '^== host ==' "$out"; then
      echo "  $node: UNREACHABLE"
      continue
    fi
  fi
  # summary line
  host="$(grep '^hostname:' "$out" | head -1 | cut -d' ' -f2)"
  os="$(grep '^os:' "$out" | head -1 | sed 's/^os: //')"
  herdr="$(grep '^herdr:' "$out" | head -1 | awk '{print $2}')"
  los_ver="$(grep -E '^LOS_VERSION=' "$out" | head -1 | cut -d= -f2)"
  echo "  $node: $host | $os | herdr=${herdr:-MISSING} | los=${los_ver:-none}"
done

echo ""
echo "Full reports: $AUDIT_DIR/$TS/"
