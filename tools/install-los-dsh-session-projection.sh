#!/bin/bash
# 安装 los DSH session projection 的 launchd 常驻任务（每小时一次）。
# 见 tools/los-dsh-session-projection.sh 顶部注释：为什么必须是 launchd，
# 以及 2026-10-09 前"没人调度它 ⇒ 读模型陈旧 23h"的来由。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.echerlos.los.dsh-session-projection"
TEMPLATE="$ROOT/tools/los-dsh-session-projection.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

as_of() {
  local psql=""
  for candidate in /opt/homebrew/opt/postgresql@*/bin/psql /opt/homebrew/opt/libpq/bin/psql; do
    [[ -x "$candidate" ]] && psql="$candidate" && break
  done
  [[ -n "$psql" ]] || psql="$(command -v psql || true)"
  local url=""
  if [[ -n "${DATABASE_URL:-}" ]]; then
    url="$DATABASE_URL"
  elif [[ -f "$ROOT/.env" ]]; then
    url="$(grep -E '^DATABASE_URL=' "$ROOT/.env" | head -1 | cut -d= -f2-)"
  fi
  [[ -n "$psql" && -n "$url" ]] || { echo "as_of: unknown (psql/db url missing)"; return 0; }
  echo "as_of: $("$psql" "$url" -tAc "SELECT to_char(max(as_of), 'YYYY-MM-DD HH24:MI') FROM dsh_session_catalog;" 2>/dev/null | tr -d ' ')"
}

status() {
  echo "── $LABEL ──"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" | grep -E "state =|runs =|last exit code" || true
  else
    echo "not loaded"
  fi
  as_of
  local log="$ROOT/.los-runtime/dsh-projection.log"
  [[ -f "$log" ]] && tail -3 "$log"
}

[[ "${1:-}" == "--status" ]] && { status; exit 0; }
if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$TARGET"
  echo "uninstalled $LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.los-runtime"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# 2026-10-13：模板新增 `__HOME__` 占位符（WatchPaths 要指向 ~/.dsh 下的上游心跳）。
# 两个占位符都必须替换：漏掉一个会让 plist 里留下字面 `__HOME__`，launchd 会照常加载、
# 但 WatchPaths 永远不命中 —— 正是本仓反复说的"装了 ≠ 在起作用"，所以这里同时做
# **渲染后断言**：结果里不得残留任何 `__` 占位符。
sed -e "s|__LOS_ROOT__|$ROOT|g" -e "s|__HOME__|$HOME|g" "$TEMPLATE" > "$TARGET"
if grep -q '__[A-Z_]*__' "$TARGET"; then
  echo "install: 渲染后仍有未替换的占位符，拒绝 bootstrap：" >&2
  grep -n '__[A-Z_]*__' "$TARGET" >&2
  exit 2
fi
launchctl bootstrap "$DOMAIN" "$TARGET"

echo "── 验收：同步跑一次投影（RunAtLoad=false，故由安装脚本触发）──"
bash "$ROOT/tools/los-dsh-session-projection.sh" || echo "projection rc=$?"
status
