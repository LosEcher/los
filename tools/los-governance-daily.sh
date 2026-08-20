#!/usr/bin/env bash
#
# los governance daily digest — 治理日报（供 DSH 每日拉取/推送）
#
# 汇总四类需要 operator 关注的 los 治理面：
#   1. governance_jobs 异常状态（paused / circuit open / 连续失败）
#   2. 定时任务待审批 run（awaiting_approval）
#   3. 未确认死信（dead_letter_events）
#   4. GA 升级 / 治理来源 todo（未完成）
# 另附当前启用的定时任务清单（下次运行时间）。
#
# 用法:
#   tools/los-governance-daily.sh            # 异常项 + 启用任务
#   tools/los-governance-daily.sh --full     # 额外输出全部 governance jobs
#
# 数据源: DATABASE_URL（优先取环境变量，其次 .env）。psql 自动探测
# /opt/homebrew/opt/postgresql@*/bin/psql，最后退回 PATH。
#
# 输出为 markdown，可直接作为 de_channel_send 的正文。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FULL=0
[[ "${1:-}" == "--full" ]] && FULL=1

# ── 定位 psql ───────────────────────────────────────────────
PSQL_BIN="${PSQL:-}"
if [[ -z "$PSQL_BIN" ]]; then
  for p in /opt/homebrew/opt/postgresql@*/bin/psql; do
    [[ -x "$p" ]] && PSQL_BIN="$p" && break
  done
fi
if [[ -z "$PSQL_BIN" ]]; then
  PSQL_BIN="$(command -v psql || true)"
fi
if [[ -z "$PSQL_BIN" ]]; then
  echo "ERROR: psql not found (set PSQL or install postgresql)" >&2
  exit 1
fi

# ── DATABASE_URL ─────────────────────────────────────────────
DB_URL="${DATABASE_URL:-}"
if [[ -z "$DB_URL" && -f "$ROOT/.env" ]]; then
  DB_URL="$(grep -E '^DATABASE_URL=' "$ROOT/.env" | head -1 | cut -d= -f2-)"
fi
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: DATABASE_URL not set and .env missing" >&2
  exit 1
fi

q() { "$PSQL_BIN" "$DB_URL" -A -F ' | ' -t -c "$1"; }
table() { # table <header> <rows...>
  local header="$1"
  shift
  echo "| $header |"
  echo "|" "$(echo "$header" | sed 's/[^|]/---/g')" "|"
  for row in "$@"; do
    echo "| $row |"
  done
}

NOW="$(date '+%Y-%m-%d %H:%M %Z')"
echo "# los 治理日报 ($NOW)"
echo

# ── 1. Governance jobs 异常 ──────────────────────────────────
echo "## 1. Governance jobs（异常项）"
if [[ "$FULL" -eq 1 ]]; then
  ROWS=$(q "SELECT job_type || ' [' || cadence || ']' || ' | ' || status || ' | ' || circuit_state || ' | fail=' || consecutive_failures || ' | last=' || COALESCE(to_char(last_run_at, 'MM-DD HH24:MI'), '-') || ' | next=' || COALESCE(to_char(next_run_at, 'MM-DD HH24:MI'), '-') FROM governance_jobs ORDER BY status, job_type, cadence;")
else
  ROWS=$(q "SELECT job_type || ' [' || cadence || ']' || ' | ' || status || ' | ' || circuit_state || ' | fail=' || consecutive_failures || ' | last=' || COALESCE(to_char(last_run_at, 'MM-DD HH24:MI'), '-') || ' | next=' || COALESCE(to_char(next_run_at, 'MM-DD HH24:MI'), '-') FROM governance_jobs WHERE status <> 'active' OR circuit_state <> 'closed' OR consecutive_failures > 0 ORDER BY status, job_type, cadence;")
fi
if [[ -n "$ROWS" ]]; then
  table "job | status | circuit | failures | last | next" "$ROWS"
else
  echo "- 无异常（全部 active / closed / 0 失败）"
fi
echo

# ── 2. 定时任务待审批 ───────────────────────────────────────
echo "## 2. 定时任务待审批（awaiting_approval）"
ROWS=$(q "SELECT r.id || ' | ' || s.title || ' | for=' || to_char(r.scheduled_for, 'MM-DD HH24:MI') || ' | policy=' || s.approval_policy || ' | timeout=' || (s.approval_timeout_ms / 60000) || 'min' FROM scheduled_work_item_runs r JOIN scheduled_work_items s ON s.id = r.schedule_id WHERE r.status = 'awaiting_approval' ORDER BY r.scheduled_for;")
if [[ -n "$ROWS" ]]; then
  table "run_id | 任务 | 计划时间 | 审批策略 | 超时" "$ROWS"
  echo
  echo "审批: tools/los-schedule-ctl.sh approve <run_id>"
else
  echo "- 无"
fi
echo

# ── 3. 未确认死信 ───────────────────────────────────────────
echo "## 3. 未确认死信（dead_letter_events）"
ROWS=$(q "SELECT id || ' | ' || reason || ' | ' || to_char(created_at, 'MM-DD HH24:MI') || ' | ' || left(COALESCE(original_error, ''), 60) FROM dead_letter_events WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 15;")
if [[ -n "$ROWS" ]]; then
  table "id | reason | created | error" "$ROWS"
else
  echo "- 无"
fi
echo

# ── 4. GA 升级 / 治理 todo ──────────────────────────────────
echo "## 4. 未完成治理/GA 升级 todo"
ROWS=$(q "SELECT id || ' | ' || left(title, 70) || ' | ' || priority || ' | ' || status FROM todos WHERE archived_at IS NULL AND status NOT IN ('done', 'cancelled') AND (source = 'ga_loop' OR title LIKE 'GA Loop%' OR title LIKE 'GA 升级%') AND priority IN ('P0', 'P1', 'P2') ORDER BY priority DESC, updated_at DESC LIMIT 15;")
if [[ -n "$ROWS" ]]; then
  table "id | title | priority | status" "$ROWS"
else
  echo "- 无"
fi
echo

# ── 5. 启用的定时任务 ──────────────────────────────────────
echo "## 5. 启用的定时任务（scheduled_work_items）"
ROWS=$(q "SELECT title || ' | ' || (run_template_json->>'templateId') || ' | ' || (trigger_json->>'kind') || ' ' || COALESCE(trigger_json->>'expression', trigger_json->>'intervalSeconds') || ' | ' || circuit_state || ' | next=' || to_char(next_run_at, 'MM-DD HH24:MI') FROM scheduled_work_items WHERE status = 'enabled' ORDER BY next_run_at;")
if [[ -n "$ROWS" ]]; then
  table "任务 | 模板 | 触发 | circuit | next" "$ROWS"
else
  echo "- 无启用任务"
fi
echo

# ── 6. 网络/surge 观测 verdict ─────────────────────────────
echo "## 6. 网络/surge 观测 verdict"
NW_DIR="$ROOT/.los-runtime/network-observe"
LATEST_NW="$(ls -t "$NW_DIR/reports/"*-analysis.md 2>/dev/null | head -1)"
LATEST_SG="$(ls -t "$NW_DIR/surge-reports/"*-surge-analysis.md 2>/dev/null | head -1)"
age_hours() { # 文件 mtime 距今小时数
  local f="$1"
  echo $(( ($(date +%s) - $(stat -f %m "$f")) / 3600 ))
}
if [[ -n "$LATEST_NW" ]]; then
  NW_AGE=$(age_hours "$LATEST_NW")
  NW_VERDICT="$(awk '/^##.*Verdict/{f=1;next} f && NF {print; exit}' "$LATEST_NW" | sed 's/^\*\*//; s/\*\*.*//' | cut -d' ' -f1)"
  NW_FLAG=""; [[ "$NW_AGE" -gt 36 ]] && NW_FLAG=" [STALE ${NW_AGE}h]"
  echo "- network-observe: ${NW_VERDICT:-?}（${NW_AGE}h 前报告）${NW_FLAG}"
else
  echo "- network-observe: 无报告"
fi
if [[ -n "$LATEST_SG" ]]; then
  SG_AGE=$(age_hours "$LATEST_SG")
  SG_VERDICT="$(awk '/^##.*Verdict/{f=1;next} f && NF {print; exit}' "$LATEST_SG" | sed 's/^\*\*//; s/\*\*.*//' | cut -d' ' -f1)"
  SG_FLAG=""; [[ "$SG_AGE" -gt 12 ]] && SG_FLAG=" [STALE ${SG_AGE}h]"
  echo "- surge: ${SG_VERDICT:-?}（${SG_AGE}h 前报告）${SG_FLAG}"
else
  echo "- surge: 无报告"
fi
echo

# ── 汇总 ────────────────────────────────────────────────────
GOV_CNT=$(q "SELECT count(*) FROM governance_jobs WHERE status <> 'active' OR circuit_state <> 'closed' OR consecutive_failures > 0;")
APP_CNT=$(q "SELECT count(*) FROM scheduled_work_item_runs WHERE status = 'awaiting_approval';")
DL_CNT=$(q "SELECT count(*) FROM dead_letter_events WHERE acknowledged_at IS NULL;")
TODO_CNT=$(q "SELECT count(*) FROM todos WHERE archived_at IS NULL AND status NOT IN ('done', 'cancelled') AND (source = 'ga_loop' OR title LIKE 'GA Loop%' OR title LIKE 'GA 升级%') AND priority IN ('P0', 'P1', 'P2');")
echo "---"
echo "汇总: 治理异常=${GOV_CNT:-0} 待审批=${APP_CNT:-0} 死信=${DL_CNT:-0} 治理todo=${TODO_CNT:-0} 网络=${NW_VERDICT:-?} surge=${SG_VERDICT:-?}"
