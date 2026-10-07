#!/bin/bash
# 安装 los fleet snapshot 的 launchd 常驻任务（每 6h 采集一次集群版本快照）。
# 见 tools/los-fleet-snapshot.plist 顶部注释：为什么不能用 los 沙箱或 DSH 调度器来跑。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.echerlos.los.fleet-snapshot"
TEMPLATE="$ROOT/tools/los-fleet-snapshot.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

status() {
  echo "── $LABEL ──"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" | grep -E "state =|runs =|last exit code" || true
  else
    echo "not loaded"
  fi
  local snap="$ROOT/.los-runtime/fleet/fleet-versions.json"
  [[ -f "$snap" ]] && echo "snapshot: $(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$snap")" || echo "snapshot: missing"
}

[[ "${1:-}" == "--status" ]] && { status; exit 0; }
if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$TARGET"; echo "uninstalled $LABEL"; exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.los-runtime/fleet"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
sed "s|__LOS_ROOT__|$ROOT|g" "$TEMPLATE" > "$TARGET"
launchctl bootstrap "$DOMAIN" "$TARGET"
sleep 20   # RunAtLoad=true，launchd 会立刻采一次
status
