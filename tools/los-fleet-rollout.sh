#!/bin/bash
# los-fleet-rollout.sh — 集群滚动发布的**协调器**（reconcile，而不是命令序列）
#
# 设计依据：docs/operations/2026-10-07-fleet-rollout-design.md
# 三条原则：
#   1. 状态从节点读（/health.version + 注册表 version/status + 远端 build-version），
#      不从本地进度文件读 —— 因此任何时刻中断都可重入；
#   2. 每一步的成功判据是节点上的**可观测事实**（摘要一致、版本一致、注册表回到 online），
#      不是命令的退出码；
#   3. 幂等：已收敛的节点直接跳过。
#
# 传输/解包/校验/自动 promote 全部**复用 tools/deploy-to-remote.sh**，本脚本不再第二次
# 实现那套脆弱逻辑（2026-10-06 的教训：两套实现必然漂移）。
#
# 用法：
#   bash tools/los-fleet-rollout.sh --plan                 # 只打印计划，不改任何东西
#   bash tools/los-fleet-rollout.sh --canary               # 先滚 1 台，通过后再滚其余
#   bash tools/los-fleet-rollout.sh                        # 按节点表顺序滚（fail-fast）
#   bash tools/los-fleet-rollout.sh --node vultr-executor  # 只滚一台
#   bash tools/los-fleet-rollout.sh --continue-on-error     # 失败继续（默认 fail-fast）
#
# 环境：LOS_ROLLOUT_TARGET 可覆盖目标摘要（默认取本机 build-version）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PLAN=0; CANARY=0; CONTINUE=0; ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan) PLAN=1 ;;
    --canary) CANARY=1 ;;
    --continue-on-error) CONTINUE=1 ;;
    --node) ONLY="${2:-}"; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# 节点表：node_id|platform|ssh_alias|remote_home|privilege
# platform=local 表示网关主机自身（不经过 ssh）。
NODES=(
  "vultr-executor|linux|vultr-r-t|/opt/los|none"
  "tencent-sin-executor|linux|tencent-sin-t|/opt/los|none"
  "oracle-executor|linux|oracle-t|/opt/los|sudo"
  "node34-executor-1|linux|localnode34-r-t|/opt/los|none"
  "m3pro-executor-1|macos|m3-t|/Users/echerlos/.local/share/los|none"
  "desktop-r45553o|windows|win-los|C:/los|none"
  "desktop-srsbe20|windows|desktop-srsbe20|C:/los|none"
  "mbp-executor-1|local|||"
)
SSHO=(-o BatchMode=yes -o ConnectTimeout=20 -o ControlPath=none -o ControlMaster=no)
PSQL="$(command -v psql || echo /opt/homebrew/opt/postgresql@17/bin/psql)"
DB_URL="$(grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
AUTH="$(grep -E '^LOS_AUTH_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
OP="$(grep -E '^LOS_OPERATOR_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
TARGET="${LOS_ROLLOUT_TARGET:-$(bash tools/los.sh build-version | tail -1)}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT/.los-runtime/rollouts"; mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/${STAMP}-rollout.json"
LOCK="$ROOT/.los-runtime/rollouts/.lock"

log()  { printf '[rollout] %s\n' "$*"; }
warn() { printf '[rollout] WARN: %s\n' "$*" >&2; }
die()  { printf '[rollout] FATAL: %s\n' "$*" >&2; exit 1; }

# ── 锁：阻止并发滚动（2026-10-06 真的撞过一次）────────────────
if [[ "$PLAN" -eq 0 ]]; then
  if ! mkdir "$LOCK" 2>/dev/null; then
    holder="$(cat "$LOCK/pid" 2>/dev/null || echo '?')"
    if [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
      die "another rollout is running (pid $holder); lock=$LOCK"
    fi
    warn "stale lock from pid $holder — taking over"
    rm -rf "$LOCK"; mkdir "$LOCK" || die "cannot take lock $LOCK"
  fi
  echo $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
fi

# ── preflight：控制面不健康就不要开跑（它既 verify 不了也 promote 不了）──
preflight() {
  local h
  h="$(curl -s -m 8 http://127.0.0.1:8080/health 2>/dev/null)"
  printf '%s' "$h" | grep -q '"ready":true' || die "gateway not ready — refusing to start a rollout"
  "$PSQL" "$DB_URL" -t -A -c 'select 1' >/dev/null 2>&1 || die "database unreachable — refusing to start a rollout"
  printf '%s' "$h" | grep -q "\"version\":\"$TARGET\"" && warn "gateway already runs the target digest"
}
[[ "$PLAN" -eq 0 ]] && preflight

q() { "$PSQL" "$DB_URL" -t -A -c "$1" 2>/dev/null | tr -d ' \r'; }
reg_version()  { q "select coalesce(version,'') from executor_nodes where node_id='$1'"; }
reg_status()   { q "select coalesce(status,'') from executor_nodes where node_id='$1'"; }
reg_active()   { q "select coalesce(active_task_count,0) from executor_nodes where node_id='$1'"; }
reg_target()   { q "select coalesce(target_version,'') from executor_nodes where node_id='$1'"; }
set_target()   { "$PSQL" "$DB_URL" -c "update executor_nodes set target_version='$TARGET', updated_at=now() where node_id='$1'" >/dev/null 2>&1; }
promote_node() { ./bin/los nodes command "$1" promote -t "$AUTH" ${OP:+--operator-token "$OP"} --reason "fleet rollout $TARGET" >/dev/null 2>&1; }
health_version() { # ip:port
  curl -s -m 8 "http://$1/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1
}

# 远端摘要 = 节点自查（与 deploy-to-remote.sh digest 同一判据）
remote_digest() { # alias home privilege
  local a="$1" home="$2" priv="$3" cmd
  cmd="cd '$home' && bash tools/los.sh build-version 2>/dev/null | tail -1"
  if [[ "$priv" = "sudo" ]]; then
    ssh "${SSHO[@]}" "$a" "sudo -n bash -c \"$cmd\"" 2>/dev/null | tr -d ' \r'
  else
    ssh "${SSHO[@]}" "$a" "$cmd" 2>/dev/null | tr -d ' \r'
  fi
}

tool() { # alias home priv subcmd [extra...] — 统一调用仓库工具
  local a="$1" home="$2" priv="$3"; shift 3
  LOS_SSH_TRANSPORT=ssh LOS_SSH_TARGET="$a" LOS_REMOTE_HOME="$home" \
  LOS_REMOTE_PRIVILEGE="$priv" LOS_SSH_OPTS='-o ControlPath=none -o ControlMaster=no' \
    bash tools/deploy-to-remote.sh "$NODE_NAME" "$@"
}

# ── 每节点：读实际态 → 收敛 ───────────────────────────────────
declare -a RESULTS=()
record() { RESULTS+=("$1|$2|$3"); }   # node|result|detail

roll_one() { # node_id platform alias home privilege
  local nid="$1" plat="$2" alias_="$3" home="$4" priv="$5"
  NODE_NAME="$nid"
  local v st dg
  v="$(reg_version "$nid")"; st="$(reg_status "$nid")"
  case "$plat" in
    local) dg="$(bash tools/los.sh build-version | tail -1)" ;;
    *)     dg="$(remote_digest "$alias_" "$home" "$priv")" ;;
  esac
  dg="${dg:-<no-response>}"

  if [[ "$dg" = "$TARGET" && "$v" = "$TARGET" && "$st" = "online" ]]; then
    log "  $nid: already converged (digest+registry+online) — skip"
    record "$nid" skipped "already on $TARGET"
    return 0
  fi

  if [[ "$PLAN" -eq 1 ]]; then
    local action
    case "$plat" in
      windows) action='NO DRIVER — manual (runbook: Windows Nodes)' ;;
      local)   action="$([[ "$dg" = "$TARGET" ]] && echo 'restart+promote' || echo 'restart+promote (tree is the source)')" ;;
      *)       action="$([[ "$dg" = "$TARGET" ]] && echo 'restart/verify+promote' || echo 'sync+install+restart+verify+promote')" ;;
    esac
    printf '  %-24s %-8s digest=%-26s registry=%-26s status=%-8s → %s\n' \
      "$nid" "$plat" "$dg" "${v:-?}" "${st:-?}" "$action"
    record "$nid" planned "digest=$dg registry=$v status=$st"
    return 0
  fi

  log "  $nid: $dg -> $TARGET (registry=$v status=$st)"

  # 1) drain + 等在飞任务归零（不 drain 就重启会中断在飞任务）
  if [[ "$st" = "online" ]]; then
    ./bin/los nodes command "$nid" drain -t "$AUTH" ${OP:+--operator-token "$OP"} --reason "rollout $TARGET" >/dev/null 2>&1
    local waited=0 active
    active="$(reg_active "$nid")"
    while [[ "${active:-0}" -gt 0 && "$waited" -lt 120 ]]; do
      sleep 10; waited=$((waited+10)); active="$(reg_active "$nid")"
    done
    [[ "${active:-0}" -gt 0 ]] && warn "  $nid: still $active active task(s) after ${waited}s — restarting anyway (in-flight work may be disrupted)"
  fi

  # 2) 平台相关的收敛步骤
  local rc=0
  case "$plat" in
    linux)
      tool "$alias_" "$home" "$priv" sync   || rc=1
      [[ "$rc" -eq 0 ]] && { tool "$alias_" "$home" "$priv" install --low-resource >/dev/null 2>&1 || rc=1; }
      [[ "$rc" -eq 0 ]] && { tool "$alias_" "$home" "$priv" restart >/dev/null 2>&1 || rc=1; }
      sleep 20
      if [[ "$rc" -eq 0 ]]; then
        # verify 自带版本断言 + 自动 promote + 复核 online（P0-2/P0-3/P0-7 都在里面）
        LOS_REMOTE_NODE_ID="$nid" tool "$alias_" "$home" "$priv" verify --node-id "$nid" || rc=1
      fi
      ;;
    macos)
      LOS_REMOTE_NODE_ID="$nid" tool "$alias_" "$home" "$priv" sync || rc=1
      if [[ "$rc" -eq 0 ]]; then
        ssh "${SSHO[@]}" "$alias_" "sed -i '' 's|^LOS_VERSION=.*|LOS_VERSION=$TARGET|; s|^EXECUTOR_VERSION=.*|EXECUTOR_VERSION=$TARGET|' '$home/.env'" >/dev/null 2>&1
        ssh "${SSHO[@]}" "$alias_" 'launchctl kickstart -k gui/$(id -u)/com.echerlos.los-executor' >/dev/null 2>&1 || rc=1
        sleep 20
      fi
      [[ "$rc" -eq 0 ]] && { promote_node "$nid"; sleep 8; [[ "$(reg_status "$nid")" = "online" ]] || rc=1; }
      ;;
    windows)
      # 平台差异全在驱动里（tar.exe / Restart-Service / .env 追加），编排器只管调度与判定。
      local driver="$ROOT/tools/deploy-drivers/windows-service.sh"
      if [[ ! -x "$driver" ]]; then
        rc=1
        warn "  $nid: Windows driver missing ($driver)"
      else
        bash "$driver" sync     "$alias_" "$home" "$TARGET" "$nid" || rc=1
        [[ "$rc" -eq 0 ]] && { bash "$driver" activate "$alias_" "$home" "$TARGET" "$nid" || rc=1; }
        sleep 12
        [[ "$rc" -eq 0 ]] && { bash "$driver" verify   "$alias_" "$home" "$TARGET" "$nid" || rc=1; }
        [[ "$rc" -eq 0 ]] && { promote_node "$nid"; sleep 8; [[ "$(reg_status "$nid")" = "online" ]] || rc=1; }
      fi
      ;;
    local)
      bash tools/los.sh restart >/dev/null 2>&1 || rc=1
      sleep 25
      [[ "$rc" -eq 0 ]] && { promote_node "$nid"; sleep 8; [[ "$(reg_status "$nid")" = "online" ]] || rc=1; }
      ;;
  esac

  # 3) 只有走到这里才写声明目标（P0-6：target_version 必须是 rollouts 的产物）
  if [[ "$rc" -eq 0 ]]; then
    set_target "$nid"
    log "  $nid: converged (digest=$TARGET, registry=online, target written)"
    record "$nid" ok "$TARGET"
    return 0
  fi
  warn "  $nid: FAILED to converge"
  # 它跑的还是那个**原本能工作**的修订，把它留在 draining 只会静默损失容量；
  # 恢复 online 并大声说明，比留下一个不明所以的"半死"节点好。
  if [[ "$(reg_status "$nid")" != "online" ]]; then
    promote_node "$nid" || true
    sleep 6
    warn "  $nid: restored to '$(reg_status "$nid")' on its previous revision ($(reg_version "$nid"))"
  fi
  record "$nid" failed "restored online on ${v:-previous} revision; see deploy logs"
  return 1
}

# ── 主流程 ────────────────────────────────────────────────
log "target=$TARGET plan=$PLAN canary=$CANARY continue-on-error=$CONTINUE"
[[ "$PLAN" -eq 1 ]] && log "(plan only — nothing will be modified)"
failed=0
processed=0
for row in "${NODES[@]}"; do
  IFS='|' read -r nid plat alias_ home priv <<< "$row"
  [[ -n "$ONLY" && "$nid" != "$ONLY" ]] && continue
  roll_one "$nid" "$plat" "$alias_" "$home" "$priv" || failed=$((failed+1))
  processed=$((processed+1))
  # canary：第一台成功后停下，等人确认再跑其余
  if [[ "$CANARY" -eq 1 && "$processed" -eq 1 && "$failed" -eq 0 && "$PLAN" -eq 0 ]]; then
    log "canary passed ($nid). Re-run without --canary to roll the rest."
    break
  fi
  if [[ "$failed" -gt 0 && "$CONTINUE" -eq 0 ]]; then
    die "fail-fast: $nid failed; remaining nodes untouched (use --continue-on-error to push through)"
  fi
done

# ── JSON 报告 ─────────────────────────────────────────────
{
  printf '{"startedAt":"%s","target":"%s","plan":%s,"canary":%s,"failed":%d,"nodes":[' \
    "$STAMP" "$TARGET" "$PLAN" "$CANARY" "$failed"
  first=1
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r n res det <<< "$r"
    [[ "$first" -eq 1 ]] || printf ','
    first=0
    printf '{"node":"%s","result":"%s","detail":"%s"}' "$n" "$res" "${det//\"/}"
  done
  printf ']}\n'
} > "$REPORT"
log "report: $REPORT"
if [[ "$PLAN" -eq 1 ]]; then
  log "plan complete — no changes made"
  exit 0
fi
[[ "$failed" -eq 0 ]] || die "$failed node(s) failed to converge (report: $REPORT)"
log "all selected nodes converged on $TARGET"
