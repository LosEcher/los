#!/usr/bin/env bash
# scope-mismatch-report.sh — 观察期报表：`tool.scope_mismatch` 事件分布。
#
# 用途：决定是否把 LOS_TOOL_SCOPE_ENFORCEMENT 从 warn 切到 block。
# 判据不是"事件数为 0"就够：还要看 contextMissing 的占比——它是"无法证明越权"的灰区，
# 切 block 后会被一并拒掉（见 dsfolder LOS-CAPABILITY-…-2026-10-18.md §A.6/A.7）。
#
# 用法：
#   ./tools/scope-mismatch-report.sh [days]        # 默认 7 天
#   DATABASE_URL=postgres://… ./tools/scope-mismatch-report.sh 14
set -euo pipefail

DAYS="${1:-7}"
DB="${DATABASE_URL:-postgres://los@127.0.0.1:55432/los}"

if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "days must be a non-negative integer" >&2
  exit 2
fi

psql "$DB" -v ON_ERROR_STOP=1 -P pager=off <<SQL
\echo '== tool.scope_mismatch — 按天 / scope / action =='
SELECT date_trunc('day', created_at)::date AS day,
       COALESCE(payload_json->>'scopeId', '?') AS scope_id,
       COALESCE(payload_json->>'action', payload_json->>'mode', '?') AS action,
       count(*) AS n
FROM session_events
WHERE type = 'tool.scope_mismatch'
  AND created_at > now() - interval '${DAYS} days'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

\echo '== 汇总：mismatch vs contextMissing =='
SELECT CASE WHEN payload_json ? 'contextMissing' THEN 'context_missing' ELSE 'mismatch' END AS kind,
       count(*) AS n,
       count(DISTINCT tool_name) AS tools
FROM session_events
WHERE type = 'tool.scope_mismatch'
  AND created_at > now() - interval '${DAYS} days'
GROUP BY 1 ORDER BY 1;

\echo '== Top tools =='
SELECT tool_name, count(*) AS n
FROM session_events
WHERE type = 'tool.scope_mismatch'
  AND created_at > now() - interval '${DAYS} days'
GROUP BY 1 ORDER BY n DESC, 1 LIMIT 10;

\echo '== 分母：声明了非空 scope 的工具被调用次数（否则 0 事件不可解释）=='
SELECT tool_name, count(*) AS calls
FROM session_events
WHERE type = 'tool.call'
  AND tool_name IN ('todo_list', 'todo_create', 'todo_update')
  AND created_at > now() - interval '${DAYS} days'
GROUP BY 1 ORDER BY calls DESC, 1;

\echo '== 对照：同一窗口内的 tool.approval_required =='
SELECT COALESCE(payload_json->>'action', '?') AS action, count(*) AS n
FROM session_events
WHERE type = 'tool.approval_required'
  AND created_at > now() - interval '${DAYS} days'
GROUP BY 1 ORDER BY 1;
SQL
