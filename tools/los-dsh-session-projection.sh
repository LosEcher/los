#!/usr/bin/env bash
# los-dsh-session-projection.sh — 把 DSH 的 session-index 只读投影进 los Postgres。
#
# 干什么：调用 packages/gateway/src/project-dsh-sessions.cli.ts，把
#   ~/.dsh/storages/session-index.db（DSH 侧小时任务维护）
# 投影成 los 的三张读模型表：
#   dsh_session_catalog / dsh_session_pain / dsh_context_injection
# 投影是幂等的（按投影重建），DSH 侧文件只读、不改。
#
# 为什么必须由 launchd 跑（为什么不是 los 调度器、也不是 DSH 调度器）：
#   1) DSH 调度器每个作业都是一次 headless agent 会话：要模型、要出网、要 60~90s。
#      本任务纯本地 SQLite→Postgres 搬运，不需要模型；放进 agent 里只会把
#      "模型/出网故障"混进"投影失败"，2026-10-09 08:30 的日报失败就是这种混叠。
#   2) 2026-10-09 前它**没有任何调度**：`pnpm project:dsh-sessions` 只在人手跑时执行，
#      于是 dsh_session_catalog.as_of 长期停在 2026-10-08 17:47（近 24h 陈旧），
#      而 DSH 侧源库是新鲜的 —— 消费方（dsh-dashboards 跨项目卡片、治理日报第 8 节）
#      看到的"数据"其实是旧快照。
#   3) launchd 环境 PATH 里没有 node，故本脚本显式补 PATH（与 los-launchd-wrapper.sh 同款）。
#
# 安装：bash tools/install-los-dsh-session-projection.sh
# 手动跑一次：bash tools/los-dsh-session-projection.sh
# 日志：.los-runtime/dsh-projection.log
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/.los-runtime"
LOG="$LOG_DIR/dsh-projection.log"
LOCK="$LOG_DIR/dsh-projection.lock"
CLI_ENTRY="$ROOT/packages/gateway/src/project-dsh-sessions.cli.ts"

# launchd 环境 PATH 不含用户 shell 的 fnm/pnpm 路径（实测 node 不在 /usr/bin）。
export PATH="$HOME/.cargo/bin:$HOME/Library/pnpm:$HOME/Library/Application Support/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# 单实例锁：投影会读 289MB SQLite 并写三张表，重叠跑没有意义（mkdir 原子）。
if ! mkdir "$LOCK" 2>/dev/null; then
  log "skip: another projection holds $LOCK"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# DATABASE_URL：env 优先，其次 .env（launchd 没有登录环境）。
if [[ -z "${DATABASE_URL:-}" && -f "$ROOT/.env" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ROOT/.env" | head -1 | cut -d= -f2-)"
  export DATABASE_URL
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  log "FAIL: DATABASE_URL 未设置且 .env 无该键 —— 不猜连接串"
  exit 1
fi

# 源库必须先存在：缺它是"DSH 侧索引没建"，不是"没有会话"（不许把空当成功）。
SRC_DB="$HOME/.dsh/storages/session-index.db"
if [[ ! -s "$SRC_DB" ]]; then
  log "FAIL: DSH 源库缺失或为空: $SRC_DB（检查 launchd com.echerlos.dsh-session-index）"
  exit 1
fi

NODE="$(command -v node || true)"
TSX="$(ls -d "$ROOT"/node_modules/.pnpm/tsx@*/node_modules/tsx/dist 2>/dev/null | head -1 || true)"
if [[ -z "$NODE" || -z "$TSX" || ! -f "$CLI_ENTRY" ]]; then
  log "FAIL: 运行前置缺失 node='$NODE' tsx='$TSX' entry='$CLI_ENTRY'"
  exit 1
fi

log "projection start (node=$NODE)"
set +e
( cd "$ROOT" && "$NODE" --require "$TSX/preflight.cjs" --import "file://$TSX/loader.mjs" "$CLI_ENTRY" ) >> "$LOG" 2>&1
rc=$?
set -e

# 回读新鲜度：日志里必须有 as_of，否则"跑完了"只是退出码 0（含 degraded/未刷新的情况）。
PSQL_BIN=""
for candidate in /opt/homebrew/opt/postgresql@*/bin/psql /opt/homebrew/opt/libpq/bin/psql; do
  [[ -x "$candidate" ]] && PSQL_BIN="$candidate" && break
done
[[ -n "$PSQL_BIN" ]] || PSQL_BIN="$(command -v psql || true)"
AS_OF_VALUE=""
if [[ -n "$PSQL_BIN" ]]; then
  AS_OF_VALUE="$("$PSQL_BIN" "$DATABASE_URL" -tAc "SELECT to_char(max(as_of), 'YYYY-MM-DD HH24:MI') FROM dsh_session_catalog;" 2>/dev/null | tr -d ' ')"
fi

if [[ "$rc" -ne 0 ]]; then
  log "projection FAILED rc=$rc (as_of=${AS_OF_VALUE:-unknown})"
  exit "$rc"
fi
log "projection ok rc=0 as_of=${AS_OF_VALUE:-unknown}"
