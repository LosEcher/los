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
# 两种 paused 语义不同（pause_source 区分）：
#   pause_source='operator' → 人工停止，是有意状态，不是异常，且不会被自动恢复；
#   其余（no_op_throttle / failure_threshold / circuit_open / NULL 遗留）→ 系统自暂停，
#   属异常（会由 sweep 预处理自动恢复）。
echo "## 1. Governance jobs（异常项）"
if [[ "$FULL" -eq 1 ]]; then
  ROWS=$(q "SELECT job_type || ' [' || cadence || ']' || ' | ' || status || COALESCE('/' || pause_source, '') || ' | ' || circuit_state || ' | fail=' || consecutive_failures || ' | noop=' || consecutive_no_ops || ' | last=' || COALESCE(to_char(last_run_at, 'MM-DD HH24:MI'), '-') || ' | next=' || COALESCE(to_char(next_run_at, 'MM-DD HH24:MI'), '-') FROM governance_jobs ORDER BY status, job_type, cadence;")
else
  ROWS=$(q "SELECT job_type || ' [' || cadence || ']' || ' | ' || status || COALESCE('/' || pause_source, '') || ' | ' || circuit_state || ' | fail=' || consecutive_failures || ' | last=' || COALESCE(to_char(last_run_at, 'MM-DD HH24:MI'), '-') || ' | next=' || COALESCE(to_char(next_run_at, 'MM-DD HH24:MI'), '-') FROM governance_jobs WHERE (status = 'paused' AND COALESCE(pause_source, '') <> 'operator') OR circuit_state <> 'closed' OR consecutive_failures > 0 ORDER BY status, job_type, cadence;")
fi
if [[ -n "$ROWS" ]]; then
  table "job | status | circuit | failures | last | next" "$ROWS"
else
  echo "- 无异常（无系统暂停 / circuit 全 closed / 0 失败）"
fi
OP_PAUSED=$(q "SELECT count(*) FROM governance_jobs WHERE status = 'paused' AND pause_source = 'operator';")
if [[ "${OP_PAUSED:-0}" -gt 0 ]]; then
  echo "- 人工暂停（有意，不计异常，不会被自动恢复）：${OP_PAUSED} 个 → $(q "SELECT string_agg(job_type, ', ') FROM governance_jobs WHERE status = 'paused' AND pause_source = 'operator';")"
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
# verdict 提取必须容忍两种模板写法：token 在标题行（"## Verdict — attention"）
# 或在小节正文首行（"**ATTENTION** — not all clear."）。只认标题会退化成读正文
# 首行，在编号列表格式下抽出 "1."（2026-10-06 实际发生过）。
verdict_of() { # <报告文件> -> input_stale|all_clear|attention|high|?
  local f="$1" v="" section=""
  # 1) 含 "verdict" 的关键词行（新模板把 token 写进标题：## Verdict — attention）
  v="$(grep -i 'verdict' "$f" 2>/dev/null | grep -o -i -E 'input_stale|all[ _]clear|attention|high' | head -1 || true)"
  if [[ -z "$v" ]]; then
    # Verdict 小节的正文（跳过空行；最多取前 10 行非空内容）
    section="$(awk '/^##.*[Vv]erdict/{f=1;next} f && NF {print; if (++n >= 10) exit}' "$f" 2>/dev/null || true)"
    # 2) 旧模板约定：小节首行是加粗 token（**ATTENTION** — not all clear.）
    v="$(printf '%s\n' "$section" | grep -o -E '\*\*[^*]+\*\*' | grep -o -i -E 'input_stale|all[ _]clear|attention|high' | head -1 || true)"
  fi
  if [[ -z "$v" ]]; then
    # 3) 兜底：小节正文里任意位置的首个 token
    v="$(printf '%s\n' "$section" | grep -o -i -E 'input_stale|all[ _]clear|attention|high' | head -1 || true)"
  fi
  printf '%s' "${v:-?}" | tr '[:upper:]' '[:lower:]' | tr ' ' '_'
}

# ── 桥接新鲜度门（权威判据，优先于报告 mtime）─────────────
# 桥接(com.echerlos.los.network-observe-bridge, 每 2h)一旦静默失效:
#   input/ 冻结 → 分析任务仍按 prompt 覆盖同名报告 → 报告 mtime 永远新鲜、
#   内容永远停在最后一个旧窗口。因此新鲜度必须看「同步时刻/最新输入快照」,
#   不能看 reports/*-analysis.md 的 mtime。
# 已发生两次:2026-08-28(修于 69f21863)、2026-08-31(再次静默 37 天)。
BRIDGE_FLAG=""; BRIDGE_STATE="ok"; BRIDGE_AGE=""
MANIFEST="$NW_DIR/bridge-manifest.json"
# 注意:桥接批量 cp 会让同一轮的新文件 mtime 相同,`ls -t` 排序不稳定;
# 输入文件名为 ISO 时间戳,直接用文件名排序才是「最新快照」。
NEWEST_INPUT="$(ls -1 "$NW_DIR/input/"*.json 2>/dev/null | sort -r | head -1)"
NEWEST_SURGE="$(ls -1 "$NW_DIR/surge-input/"*.json 2>/dev/null | sort -r | head -1)"
INPUT_STAMP=""; [[ -n "$NEWEST_INPUT" ]] && INPUT_STAMP="$(basename "$NEWEST_INPUT" .json)"
SURGE_STAMP=""; [[ -n "$NEWEST_SURGE" ]] && SURGE_STAMP="$(basename "$NEWEST_SURGE" .json | sed 's/^surge-errors-//')"
if [[ -f "$MANIFEST" ]]; then
  SYNCED_AT="$(sed -n 's/.*"syncedAt": *"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
  if [[ -n "$SYNCED_AT" ]]; then
    SYNCED_EPOCH="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$SYNCED_AT" +%s 2>/dev/null || echo "")"
    [[ -n "$SYNCED_EPOCH" ]] && BRIDGE_AGE=$(( ($(date +%s) - SYNCED_EPOCH) / 3600 ))
  fi
fi
if [[ -z "$BRIDGE_AGE" ]]; then
  BRIDGE_STATE="STALE"; BRIDGE_FLAG=" [BRIDGE-STALE: 无 bridge-manifest.json]"
elif [[ "$BRIDGE_AGE" -gt 4 ]]; then
  BRIDGE_STATE="STALE(${BRIDGE_AGE}h)"
  BRIDGE_FLAG=" [BRIDGE-STALE ${BRIDGE_AGE}h: verdict 基于旧快照 ${INPUT_STAMP:-?}]"
else
  BRIDGE_STATE="ok(${BRIDGE_AGE}h)"
fi
echo "- bridge: ${BRIDGE_STATE}（最新输入快照 ${INPUT_STAMP:-?}）"

if [[ -n "$LATEST_NW" ]]; then
  NW_AGE=$(age_hours "$LATEST_NW")
  NW_VERDICT="$(verdict_of "$LATEST_NW")"
  NW_FLAG=""; [[ "$NW_AGE" -gt 36 ]] && NW_FLAG=" [STALE ${NW_AGE}h]"
  echo "- network-observe: ${NW_VERDICT:-?}（报告 mtime ${NW_AGE}h / 输入快照 ${INPUT_STAMP:-?}）${NW_FLAG}${BRIDGE_FLAG}"
else
  echo "- network-observe: 无报告"
fi
if [[ -n "$LATEST_SG" ]]; then
  SG_AGE=$(age_hours "$LATEST_SG")
  SG_VERDICT="$(verdict_of "$LATEST_SG")"
  SG_FLAG=""; [[ "$SG_AGE" -gt 12 ]] && SG_FLAG=" [STALE ${SG_AGE}h]"
  echo "- surge: ${SG_VERDICT:-?}（报告 mtime ${SG_AGE}h / 输入快照 ${SURGE_STAMP:-?}）${SG_FLAG}${BRIDGE_FLAG}"
else
  echo "- surge: 无报告"
fi
echo

# ── 7. fleet executor 版本分布（漂移可见化）──────────────────
# 版本漂移此前完全不可见：registry 的 target_version 一直为空，也没有任何
# 报告口径统计过「谁跑在哪个修订上」。这里只做可见化 + 标出非多数版本节点，
# 不写 target_version（未批准滚动升级前写目标版本等于记录一个假事实）。
echo "## 7. fleet executor 版本分布与一致性（在线节点）"
FLEET_ROWS=$(q "SELECT version || ' | ' || count(*) || ' | ' || string_agg(node_id, ', ' ORDER BY node_id) FROM executor_nodes WHERE node_kind = 'executor' AND status = 'online' GROUP BY version ORDER BY count(*) DESC, version;")
FLEET_TOTAL=$(q "SELECT count(*) FROM executor_nodes WHERE node_kind = 'executor' AND status = 'online';")
if [[ -n "$FLEET_ROWS" ]]; then
  table "版本 | 节点数 | 节点" "$FLEET_ROWS"
  FLEET_DISTINCT=$(q "SELECT count(DISTINCT version) FROM executor_nodes WHERE node_kind = 'executor' AND status = 'online';")
  FLEET_MINORITY=$(q "SELECT count(*) FROM executor_nodes e WHERE e.node_kind = 'executor' AND e.status = 'online' AND e.version <> (SELECT version FROM executor_nodes WHERE node_kind = 'executor' AND status = 'online' GROUP BY version ORDER BY count(*) DESC, version LIMIT 1);")
  echo "- 在线 executor=${FLEET_TOTAL:-0}，版本种类=${FLEET_DISTINCT:-0}，非多数版本节点=${FLEET_MINORITY:-0}"
  [[ "${FLEET_MINORITY:-0}" -gt 0 ]] && echo "  → 版本漂移；滚动升级未执行（需维护窗口，见 tools/deploy-to-remote.sh <node> deploy）"
else
  echo "- 无在线 executor 记录"
fi
echo

# ── 7b. 声明目标一致性 → todo（P0-6）─────────────────────────
# `target_version` 在此之前**没有任何消费点**，于是"节点没落在声明目标上"这件事只能靠人
# 肉看版本分布发现。这里把它变成可执行的 todo，并且**自动关闭**：只有"漂移存在"才留 todo，
# 收敛后自动 done —— 否则 todo 会积累成噪音，运维就会开始忽略它。
# 幂等键 dedupe_key 保证同一节点只留一条未完成 todo。
q "INSERT INTO todos (id, tenant_id, project_id, user_id, node_id, title, description, kind, status, priority, source, dedupe_key)
   SELECT 'todo-fleet-drift-' || e.node_id, 'local', 'los', 'operator', e.node_id,
          'Fleet drift: ' || e.node_id || ' 未落在声明目标',
          '节点实际版本 ' || e.version || ' != 声明目标 ' || COALESCE(e.target_version, '(null)')
            || '。修复：对目标节点执行滚动升级（sync → install → restart → verify → promote），'
            || '并把 target_version 更新为该次下发的摘要。',
          'task', 'backlog', 'P1', 'fleet_drift', 'fleet_drift:' || e.node_id
     FROM executor_nodes e
    WHERE e.node_kind = 'executor' AND e.status = 'online'
      AND e.target_version IS NOT NULL AND e.version <> e.target_version
      AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.dedupe_key = 'fleet_drift:' || e.node_id
                        AND t.archived_at IS NULL AND t.status NOT IN ('done', 'cancelled'));" >/dev/null
q "UPDATE todos SET status = 'done', completed_at = now(), updated_at = now(),
        archive_reason = 'fleet converged: node now matches its declared target_version'
    WHERE source = 'fleet_drift' AND archived_at IS NULL AND status NOT IN ('done', 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM executor_nodes e
                       WHERE e.node_id = todos.node_id AND e.node_kind = 'executor' AND e.status = 'online'
                         AND e.target_version IS NOT NULL AND e.version <> e.target_version);" >/dev/null
DRIFT_OPEN=$(q "SELECT count(*) FROM todos WHERE source = 'fleet_drift' AND archived_at IS NULL AND status NOT IN ('done', 'cancelled');")
DRIFT_NODES=$(q "SELECT count(*) FROM executor_nodes WHERE node_kind = 'executor' AND status = 'online' AND target_version IS NOT NULL AND version <> target_version;")
if [[ "${DRIFT_NODES:-0}" -gt 0 ]]; then
  echo "- **声明目标一致性**：${DRIFT_NODES} 台未落在 target_version 上（未完成 todo=${DRIFT_OPEN}）"
  q "SELECT '  - ' || node_id || ': ' || version || ' → ' || COALESCE(target_version, '(null)') FROM executor_nodes WHERE node_kind = 'executor' AND status = 'online' AND target_version IS NOT NULL AND version <> target_version ORDER BY node_id;"
else
  echo "- 声明目标一致性：全部落在 target_version 上（fleet_drift todo 已自动关闭）"
fi
echo

# ── 8. 边界审计（ADR 0047 判据 J1–J10 的本机证据面）────────────
# 为什么放进日报：这四条检具读**本机**状态（cc-switch GUI、DSH profile、
# session-index、工作区文档），不适合进 CI，但必须有人每天看。
#
# **注意**：本脚本是 `set -euo pipefail`，而检具在发现 ERROR 时**故意**非零退出。
# 因此这里必须显式吞掉退出码 —— 日报的职责是**呈现**发现，不是因发现而自杀
# （否则有 ERROR 时整份日报发不出去，恰好丢掉最该看的内容）。
# 需要退出码的门禁语义请直接跑 `pnpm audit:boundary` / `pnpm audit:model-route:check`。
echo "## 8. 边界审计（ADR 0047）"
BOUNDARY_SUMMARY="SKIP"
if [[ -x "$ROOT/tools/boundary-audit.sh" ]]; then
  BOUNDARY_OUT="$(bash "$ROOT/tools/boundary-audit.sh" --quiet 2>&1 || true)"
  BOUNDARY_SUMMARY="$(printf '%s\n' "$BOUNDARY_OUT" | grep -m1 '^汇总:' | sed 's/^汇总: //' || true)"
  BOUNDARY_SUMMARY="${BOUNDARY_SUMMARY:-SKIP}"
  # 只列 ERROR/WARN 明细，避免日报被 OK 行淹没
  # sed 先去掉前导空格与检具前缀，再统一加 "- "，避免 "-   WARN ..." 这种双空格
  DETAIL="$(printf '%s\n' "$BOUNDARY_OUT" | grep -E 'ERR|WARN' | head -8 | sed -E 's/^[[:space:]]+//' || true)"
  if [[ -n "$DETAIL" ]]; then printf '%s\n' "$DETAIL" | sed 's/^/- /'; else echo "- 无 ERROR / WARN"; fi
else
  echo "- SKIP: tools/boundary-audit.sh 不可执行"
fi
echo

# 路由一致性（J8）：只在有冲突时列明细
ROUTE_STATE="OK"
ROUTE_CONFLICTS="$(pnpm -s audit:model-route 2>/dev/null | grep -E 'verdict   : conflict' || true)"
if [[ -n "$ROUTE_CONFLICTS" ]]; then
  ROUTE_STATE="CONFLICT"
  printf '%s\n' "$ROUTE_CONFLICTS" | sed 's/^/- /'
fi
echo "- 路由一致性（J8）: ${ROUTE_STATE}"
echo

# retired 是有意下线、operator 暂停是人工意图，都不算异常；
# 只有系统自暂停（throttle/circuit/遗留 NULL）/ circuit 非 closed / 连续失败才算。
GOV_CNT=$(q "SELECT count(*) FROM governance_jobs WHERE (status = 'paused' AND COALESCE(pause_source, '') <> 'operator') OR circuit_state <> 'closed' OR consecutive_failures > 0;")
APP_CNT=$(q "SELECT count(*) FROM scheduled_work_item_runs WHERE status = 'awaiting_approval';")
DL_CNT=$(q "SELECT count(*) FROM dead_letter_events WHERE acknowledged_at IS NULL;")
TODO_CNT=$(q "SELECT count(*) FROM todos WHERE archived_at IS NULL AND status NOT IN ('done', 'cancelled') AND (source = 'ga_loop' OR title LIKE 'GA Loop%' OR title LIKE 'GA 升级%') AND priority IN ('P0', 'P1', 'P2');")
echo "---"
echo "汇总: 治理异常=${GOV_CNT:-0} 待审批=${APP_CNT:-0} 死信=${DL_CNT:-0} 治理todo=${TODO_CNT:-0} fleet漂移=${DRIFT_NODES:-0}(todo ${DRIFT_OPEN:-0}) 网络=${NW_VERDICT:-?} surge=${SG_VERDICT:-?} 桥接=${BRIDGE_STATE} 边界=${BOUNDARY_SUMMARY:-SKIP} 路由=${ROUTE_STATE}"
