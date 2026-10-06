#!/bin/bash
# los-fleet-consistency.sh — 只读的集群一致性巡检（确定性，不依赖 LLM）
#
# 用途：作为 los 侧"执行面"的第一批确定性任务之一。判据刻意分两层——
#   [失败] 进程与账本不一致：/health.version != registry.version
#   [失败] 账本与声明目标不一致：registry.version != target_version
#   [仅提示] 本地工作树摘要 != target_version：说明网关侧树比集群目标新，
#          这是 rollout 期间/期间的正常状态，不该让全集群标红。
#          （第一版拿节点版本直接比本地工作树摘要，结果新增一个 tools/ 脚本
#           就让 8 台全部报不一致——判据错误，已修正。）
#
# 只读：不写 DB、不改节点、不动 registry。跑法：
#   bash tools/los-fleet-consistency.sh            # 人类可读
#   bash tools/los-fleet-consistency.sh --json     # 机器可读（供调度器解析）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JSON=0
SNAPSHOT=0
case "${1:-}" in
  --json) JSON=1 ;;
  --snapshot) SNAPSHOT=1 ;;
esac

DB_URL="${DATABASE_URL:-}"
if [[ -z "$DB_URL" && -f "$ROOT/.env" ]]; then
  DB_URL="$(grep -E '^DATABASE_URL=' "$ROOT/.env" | head -1 | cut -d= -f2-)"
fi
PSQL="${PSQL:-/opt/homebrew/opt/postgresql@17/bin/psql}"
[[ -x "$PSQL" ]] || PSQL="$(command -v psql || true)"
if [[ -z "$DB_URL" || -z "$PSQL" ]]; then
  echo "ERROR: need DATABASE_URL and psql" >&2
  exit 2
fi

TARGET="$(bash "$ROOT/tools/los.sh" build-version 2>/dev/null | tail -1)"
ROWS="$("$PSQL" "$DB_URL" -A -F '|' -t -c \
  "select node_id, base_url, status, coalesce(version,''), coalesce(target_version,'')
     from executor_nodes
    where node_kind='executor' and status='online'
    order by node_id;" 2>/dev/null)"

mismatch=0; checked=0; lines=(); notes=()
while IFS='|' read -r node url status ver target; do
  [[ -z "$node" ]] && continue
  checked=$((checked + 1))
  # /health 版本（端口从 base_url 取，oracle 是 8091）
  health="$(curl -s -m 8 "${url%/}/health" 2>/dev/null \
    | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)"
  [[ -z "$health" ]] && health="NO_RESPONSE"
  problems=()
  # 失败判据只针对"节点自身与它的声明目标"
  [[ "$health" != "$ver" ]] && problems+=("health($health)!=registry($ver)")
  [[ -n "$target" && "$ver" != "$target" ]] && problems+=("registry($ver)!=target_version($target)")
  [[ -n "$target" && "$health" != "$target" ]] && problems+=("health($health)!=target_version($target)")
  # 本地树与集群目标的差异只作提示，不算失败
  [[ -n "$target" && "$target" != "$TARGET" ]] && notes+=("$node: fleet target $target, local tree $TARGET")
  if [[ ${#problems[@]} -gt 0 ]]; then
    mismatch=$((mismatch + 1))
    lines+=("$node: $(IFS='; '; echo "${problems[*]}")")
  fi
done <<< "$ROWS"

if [[ "$SNAPSHOT" -eq 1 ]]; then
  # 采集模式：唯一需要网络/DB 的部分，必须在 los 沙箱**之外**跑（沙箱阻断 TCP）。
  # 产出工作区内的快照文件，供 los 的 project-write 任务只读判读。
  OUT_DIR="${LOS_FLEET_SNAPSHOT_DIR:-$ROOT/.los-runtime/fleet}"; mkdir -p "$OUT_DIR"
  {
    printf '{"capturedAt":"%s","localTarget":"%s","nodes":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET"
    first=1
    while IFS='|' read -r node url status ver target; do
      [[ -z "$node" ]] && continue
      health="$(curl -s -m 8 "${url%/}/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)"
      [[ -z "$health" ]] && health="NO_RESPONSE"
      [[ "$first" -eq 1 ]] || printf ','
      first=0
      printf '{"node":"%s","health":"%s","registry":"%s","targetVersion":"%s"}' "$node" "$health" "$ver" "$target"
    done <<< "$ROWS"
    printf ']}\n'
  } > "$OUT_DIR/fleet-versions.json"
  # 自证写入成功：沙箱/权限问题曾让"写失败但脚本仍打印成功"（2026-10-06 DSH 侧 EPERM 假成功）。
  # 只认两条硬判据：文件存在且新鲜、内容含 capturedAt 与 nodes 数组。
  ok=1
  [[ -s "$OUT_DIR/fleet-versions.json" ]] || ok=0
  grep -q '"capturedAt"' "$OUT_DIR/fleet-versions.json" 2>/dev/null || ok=0
  grep -q '"nodes":\[' "$OUT_DIR/fleet-versions.json" 2>/dev/null || ok=0
  age=$(( $(date +%s) - $(stat -f %m "$OUT_DIR/fleet-versions.json" 2>/dev/null || echo 0) ))
  [[ "$age" -le 120 ]] || ok=0
  if [[ "$ok" -ne 1 ]]; then
    echo "ERROR: snapshot write did not land (file missing/stale/malformed): $OUT_DIR/fleet-versions.json" >&2
    exit 4
  fi
  echo "snapshot written: $OUT_DIR/fleet-versions.json (verified fresh, age=${age}s)"
  cat "$OUT_DIR/fleet-versions.json"
  exit 0
fi

if [[ "$JSON" -eq 1 ]]; then
  printf '{"target":"%s","checked":%d,"mismatched":%d' "$TARGET" "$checked" "$mismatch"
  if [[ ${#lines[@]} -gt 0 ]]; then
    printf ',"localTree":"%s"' "$TARGET"
  printf ',"details":['
    for i in "${!lines[@]}"; do
      [[ "$i" -gt 0 ]] && printf ','
      printf '"%s"' "$(printf '%s' "${lines[$i]}" | sed 's/"/\\"/g')"
    done
    printf ']'
  fi
  printf '}\n'
else
  echo "fleet consistency check @ $(date '+%Y-%m-%d %H:%M:%S')"
  echo "  local target (deployable digest): $TARGET"
  echo "  online executors checked        : $checked"
  if [[ -n "$TARGET" && ${#notes[@]} -gt 0 ]]; then
    echo "  note: local working tree digest differs from the fleet target (${#notes[@]} node(s)) — expected between rollouts"
  fi
  if [[ "$mismatch" -eq 0 ]]; then
    echo "  verdict                         : all consistent"
  else
    echo "  verdict                         : $mismatch node(s) inconsistent"
    for l in "${lines[@]}"; do echo "    - $l"; done
  fi
fi

[[ "$mismatch" -eq 0 ]] || exit 1
# 一台都没检查到说明查询/DB 有问题，不能算通过
[[ "$checked" -gt 0 ]] || exit 3
exit 0

