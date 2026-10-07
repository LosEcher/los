#!/bin/bash
# install-network-observe-bridge.sh
# 幂等安装 network-observe bridge 的 launchd 常驻任务(每 2h 同步一次)。
#
# 背景:该桥接曾两次静默失效(2026-08-28 / 2026-08-31),导致 los 侧
# .los-runtime/network-observe/input 冻结,而分析任务仍每天覆盖报告 →
# 报告 mtime 全新但内容停在旧窗口。装成 launchd 常驻 + 新鲜度门禁可根治。
#
# 用法:
#   bash tools/install-network-observe-bridge.sh          # 安装/更新并验证
#   bash tools/install-network-observe-bridge.sh --status # 只看状态
#   bash tools/install-network-observe-bridge.sh --uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.echerlos.los.network-observe-bridge"
TEMPLATE="$ROOT/tools/network-observe-bridge.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

status() {
  echo "── $LABEL ──"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" | grep -E "state =|runs =|last exit code" || true
  else
    echo "not loaded"
  fi
  local manifest="$ROOT/.los-runtime/network-observe/bridge-manifest.json"
  if [ -f "$manifest" ]; then
    echo "manifest: $(grep -o '"syncedAt": *"[^"]*"' "$manifest" | head -1)"
  else
    echo "manifest: missing"
  fi
}

if [ "${1:-}" = "--status" ]; then
  status
  exit 0
fi

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$TARGET"
  echo "uninstalled $LABEL"
  exit 0
fi

[ -f "$TEMPLATE" ] || { echo "error: missing $TEMPLATE" >&2; exit 1; }
[ -f "$ROOT/tools/sync-network-observe.sh" ] || { echo "error: missing sync script" >&2; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.los-runtime/network-observe"

# 先卸载旧实例,避免 bootstrap 因已加载而失败(幂等)
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

sed "s|__LOS_ROOT__|$ROOT|g" "$TEMPLATE" > "$TARGET"

launchctl bootstrap "$DOMAIN" "$TARGET"
# RunAtLoad=true,launchd 会立即跑一次同步;给它一点时间落盘
sleep 8

status

if grep -q '"syncedAt"' "$ROOT/.los-runtime/network-observe/bridge-manifest.json" 2>/dev/null; then
  echo "OK: bridge installed and manifest present"
else
  echo "WARN: bridge installed but manifest not written — 检查 .los-runtime/network-observe/bridge.err.log" >&2
  exit 1
fi
