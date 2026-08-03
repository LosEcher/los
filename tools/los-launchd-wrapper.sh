#!/usr/bin/env bash
# los-launchd-wrapper.sh — launchd 常驻循环,保证 los gateway+executor 在线。
#
# 背景:gateway/executor 由 los.sh start 以 daemon 方式托管(pid 文件 + 日志),
# launchd 无法直接 KeepAlive 这些 daemon 进程,因此本 wrapper 以 30s 间隔
# 做健康检查;服务不在线时调用 los.sh start(幂等)拉起。
#
# 安装(模板 tools/los-launchd.plist,替换 __LOS_ROOT__ 后装入 LaunchAgents):
#   sed "s|__LOS_ROOT__|$PWD|g" tools/los-launchd.plist \
#     > ~/Library/LaunchAgents/com.los.daemon.plist
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.los.daemon.plist
# 卸载:
#   launchctl bootout gui/$(id -u)/com.los.daemon
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.los-runtime"
LOG="$LOG_DIR/launchd-wrapper.log"
INTERVAL_SECONDS="${LOS_LAUNCHD_INTERVAL:-30}"

# launchd 环境 PATH 不含用户 shell 的 fnm/pnpm 路径,手动补齐(curl 亦需要)。
export PATH="$HOME/Library/pnpm:$HOME/Library/Application Support/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# EXECUTOR_ENABLED 缺省视为 true(los.sh 同语义:仅显式 false 时禁用)。
is_executor_enabled() {
  local val
  val="$(grep -E '^EXECUTOR_ENABLED=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')"
  [ "${val:-true}" != "false" ]
}

http_ok() {
  local url="$1"
  [ "$(curl -sf -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)" = "200" ]
}

log "wrapper started (pid $$, interval=${INTERVAL_SECONDS}s)"

while true; do
  gw_ok=false
  ex_ok=false
  http_ok "http://127.0.0.1:8080/health" && gw_ok=true
  if is_executor_enabled; then
    http_ok "http://127.0.0.1:8090/health" && ex_ok=true
  else
    ex_ok=true
  fi

  if [ "$gw_ok" = false ] || [ "$ex_ok" = false ]; then
    log "unhealthy gateway=$gw_ok executor=$ex_ok — running los.sh start"
    ( cd "$ROOT" && ./tools/los.sh start ) >> "$LOG" 2>&1
    log "start finished rc=$?"
  fi
  sleep "$INTERVAL_SECONDS"
done
