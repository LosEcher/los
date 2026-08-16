#!/usr/bin/env bash
#
# los scheduled-work operator 控制台 — DSH 会话内审批/触发定时任务
#
# 用法:
#   tools/los-schedule-ctl.sh list-approvals            # 列出待审批 run
#   tools/los-schedule-ctl.sh approve <runId>           # 审批一个 run（异步排队执行）
#   tools/los-schedule-ctl.sh deny <runId>              # 拒绝一个 run
#   tools/los-schedule-ctl.sh trigger <scheduleId>      # 手动触发一个 schedule
#   tools/los-schedule-ctl.sh run-status <runId>        # 查看一个 run 的状态
#
# 依赖: .env 中的 LOS_GATEWAY_URL（默认 http://127.0.0.1:8080）与
# LOS_OPERATOR_TOKEN（x-los-operator-token 头）。这两个变量缺失时报错，
# 不默认放行。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 配置（.env 优先，环境变量兜底）──────────────────────────
env_val() {
  local key="$1" default="$2" val=""
  val="${!key:-}"
  if [[ -z "$val" && -f "$ROOT/.env" ]]; then
    val="$(grep -E "^${key}=" "$ROOT/.env" | head -1 | cut -d= -f2-)"
  fi
  echo "${val:-$default}"
}

BASE_URL="$(env_val LOS_GATEWAY_URL 'http://127.0.0.1:8080')"
TOKEN="$(env_val LOS_OPERATOR_TOKEN '')"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: LOS_OPERATOR_TOKEN 未设置（.env 或环境变量）" >&2
  exit 1
fi

api() { # api <method> <path> [body]
  local method="$1" path="$2" body="${3:-}"
  # Fastify rejects POST/PATCH with an empty JSON body; send '{}' when the
  # route needs no payload.
  if [[ "$method" == "POST" || "$method" == "PATCH" ]] && [[ -z "$body" ]]; then
    body='{}'
  fi
  local args=(-sS -X "$method" "$BASE_URL$path"
    -H "x-los-operator-token: $TOKEN" -H "Content-Type: application/json")
  if [[ -n "$body" ]]; then args+=(-d "$body"); fi
  curl "${args[@]}"
}

usage() {
  echo "用法: $0 <list-approvals|approve|deny|trigger|run-status> [id]"
  exit 1
}

list_approvals() {
  # 待审批列表直接查库比走 API 简单（API 无现成过滤端点）
  local psql_bin="${PSQL:-}"
  if [[ -z "$psql_bin" ]]; then
    for p in /opt/homebrew/opt/postgresql@*/bin/psql; do
      [[ -x "$p" ]] && psql_bin="$p" && break
    done
  fi
  psql_bin="${psql_bin:-$(command -v psql || true)}"
  local db_url="${DATABASE_URL:-}"
  if [[ -z "$db_url" && -f "$ROOT/.env" ]]; then
    db_url="$(grep -E '^DATABASE_URL=' "$ROOT/.env" | head -1 | cut -d= -f2-)"
  fi
  if [[ -z "$psql_bin" || -z "$db_url" ]]; then
    echo "ERROR: 需要 psql 与 DATABASE_URL 才能 list-approvals" >&2
    exit 1
  fi
  "$psql_bin" "$db_url" -A -F ' | ' -c \
    "SELECT r.id || ' | ' || s.title || ' | ' || r.scheduled_for || ' | ' || s.approval_policy
     FROM scheduled_work_item_runs r JOIN scheduled_work_items s ON s.id = r.schedule_id
     WHERE r.status = 'awaiting_approval' ORDER BY r.scheduled_for;"
}

CMD="${1:-}"
case "$CMD" in
  list-approvals)
    list_approvals
    ;;
  approve)
    [[ $# -ge 2 ]] || usage
    api POST "/scheduled-work-item-runs/$2/approve"
    echo
    ;;
  deny)
    [[ $# -ge 2 ]] || usage
    api POST "/scheduled-work-item-runs/$2/deny"
    echo
    ;;
  trigger)
    [[ $# -ge 2 ]] || usage
    api POST "/scheduled-work-items/$2/trigger"
    echo
    ;;
  run-status)
    [[ $# -ge 2 ]] || usage
    api GET "/scheduled-work-item-runs/$2"
    echo
    ;;
  *)
    usage
    ;;
esac
