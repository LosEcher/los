#!/usr/bin/env bash
# executor.sh — thin compatibility wrapper that delegates to los.sh.
# Kept for backward compatibility with pnpm run executor:* scripts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOS_SH="$ROOT/tools/los.sh"

case "${1:-help}" in
  help|-h|--help)
    echo "los executor — delegates to los.sh"
    echo "Use 'los.sh help' for full command listing."
    ;;
  status)   exec "$LOS_SH" status-executor ;;
  start)    exec "$LOS_SH" start-executor ;;
  stop)     exec "$LOS_SH" stop-executor ;;
  restart)  "$LOS_SH" stop-executor && exec "$LOS_SH" start-executor ;;
  drain)    exec "$LOS_SH" drain-executor "${2:-}" ;;
  promote)  exec "$LOS_SH" promote-executor ;;
  upgrade)  "$LOS_SH" stop-executor && exec "$LOS_SH" start-executor ;;
  *)        exec "$LOS_SH" "$@" ;;
esac
