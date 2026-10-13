#!/bin/bash
# sync-network-observe.sh
# Bridge aidebug network-observe outputs into the los workspace so los
# scheduled agents can analyze them (los agent sandbox cannot read paths
# outside its workspace root).
#
# Pulls the newest N reports + snapshots (same retention window as
# network-observe.mjs) from:
#   ~/syncfolder/project/aidebug/.network-observe/   (moved 2026-08 from ~/Downloads/projects/aidebug)
# into:
#   <los workspace>/.los-runtime/network-observe/input/
# and writes bridge-manifest.json with sync metadata.
#
# Read-only with respect to the source; only writes into the los workspace.
set -euo pipefail

AIDEBUG_ROOT="${AIDEBUG_ROOT:-$HOME/syncfolder/project/aidebug}"
SRC_ROOT="$AIDEBUG_ROOT/.network-observe"
DST_ROOT="$(cd "$(dirname "$0")/.." && pwd)/.los-runtime/network-observe"
DST_INPUT="$DST_ROOT/input"
KEEP=14   # match network-observe.mjs retention window (14 days)

if [ ! -d "$SRC_ROOT/reports" ] || [ ! -d "$SRC_ROOT/snapshots" ]; then
  echo "error: source dirs missing under $SRC_ROOT" >&2
  exit 1
fi

# ── 上游新鲜度门禁（2026-10-13 修竞态）────────────────────────────────────────
# 背景（实测，不是假想）：本桥与 `com.echerlos.aidebug.network-observe` **都是 7200s
# 独立定时**、彼此无排序，于是桥可能跑在源产出之前——`bridge-manifest.json` 记的
# `syncedAt=2026-10-13T02:01:56Z`，而源目录里最新快照是 `02-04-52`，即**桥搬运的是
# 上一轮的数据**。在没有事件总线之前，这里至少要做到两点：
#   ① 源太旧（上游坏了/停了）⇒ **显式失败**，而不是照旧成功并报绿；
#   ② 把"源最新时间戳"与 syncedAt 一起写进 manifest，让竞态**在产物上可查**
#      （将来做事件化时，这就是"桥落后了多少"的判据来源）。
NEWEST_SRC="$(ls -1t "$SRC_ROOT"/snapshots/*.json 2>/dev/null | head -n 1 || true)"
SRC_MAX_AGE_S="${NETWORK_OBSERVE_SRC_MAX_AGE_S:-10800}"   # 默认 3h（上游周期 2h + 余量）
if [ -z "$NEWEST_SRC" ]; then
  echo "FAIL: 源目录没有任何快照（上游从未产出？）: $SRC_ROOT/snapshots" >&2
  exit 1
fi
SRC_MTIME="$(stat -f '%m' "$NEWEST_SRC")"
SRC_AGE_S="$(( $(date +%s) - SRC_MTIME ))"
if [ "$SRC_AGE_S" -gt "$SRC_MAX_AGE_S" ]; then
  echo "FAIL: 上游快照陈旧 ${SRC_AGE_S}s > ${SRC_MAX_AGE_S}s（$(basename "$NEWEST_SRC")）—— 本次不桥接，避免把旧数据当新" >&2
  exit 1
fi
SRC_NEWEST_ISO="$(date -u -r "$SRC_MTIME" +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$DST_INPUT"

# Copy newest KEEP reports and snapshots by filename timestamp (ISO sortable).
# ⚠️ `ls` 必须显式吞掉 stderr 并兜住管道退出码：目录为空时 `ls` 退出 1，而本脚本开头是
# `set -euo pipefail` ⇒ `ls … | sort | head | while` 整体为 1 ⇒ **整个桥接在这一行静默死掉**
# （2026-10-13 实测：源目录为空时 rc=1 且没有任何错误输出，只在 `bash -x` 下才看得见）。
ls -1 "$SRC_ROOT/reports"/*.md 2>/dev/null | sort -r | head -n "$KEEP" | while read -r f; do
  cp -f "$f" "$DST_INPUT/"
done || true
ls -1 "$SRC_ROOT/snapshots"/*.json 2>/dev/null | sort -r | head -n "$KEEP" | while read -r f; do
  cp -f "$f" "$DST_INPUT/"
done || true

# Defensive cleanup of stale files in DST beyond KEEP.
ls -1 "$DST_INPUT"/*.md 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done || true
ls -1 "$DST_INPUT"/*.json 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done || true

LATEST_REPORT=$(ls -1 "$DST_INPUT"/*.md 2>/dev/null | sort -r | head -n 1 | xargs -n1 basename 2>/dev/null || echo "")
LATEST_SNAPSHOT=$(ls -1 "$DST_INPUT"/*.json 2>/dev/null | sort -r | head -n 1 | xargs -n1 basename 2>/dev/null || echo "")
REPORT_COUNT=$(ls -1 "$DST_INPUT"/*.md 2>/dev/null | wc -l | tr -d ' ')
SNAPSHOT_COUNT=$(ls -1 "$DST_INPUT"/*.json 2>/dev/null | wc -l | tr -d ' ')

# ── Surge log error window (2h, matching the 1500/4000 per-hour thresholds) ──
SURGE_DIR="$DST_ROOT/surge-input"
mkdir -p "$SURGE_DIR"
SURGE_TS=$(date -u +%Y-%m-%dT%H-%M-%S)
NODE_BIN="/Users/echerlos/Library/Application Support/fnm/aliases/default/bin/node"
SURGE_OK=0
if [ -x "$NODE_BIN" ]; then
  # ⚠️ 这里**不能**写成 `if cmd > file; then`：node 缺失/脚本缺失时它仍然以非 0 结束，
  # 而 `set -e` 会**在 if 的条件里也生效**（实测：允许降级的分支根本到不了，rc 恒为 1）。
  # 判据：捕获退出码，再自己决定是降级还是失败。
  if "$NODE_BIN" "$AIDEBUG_ROOT/scripts/surge-ai-window.mjs" --minutes 120 --json > "$SURGE_DIR/surge-errors-$SURGE_TS.json" 2>/dev/null; then
    SURGE_OK=1
  else
    rm -f "$SURGE_DIR/surge-errors-$SURGE_TS.json"
  fi
fi
if [ "$SURGE_OK" = "1" ]; then
  # keep newest 24 surge windows
  ls -1 "$SURGE_DIR"/surge-errors-*.json 2>/dev/null | sort -r | tail -n +25 | while read -r f; do rm -f "$f"; done || true
  SURGE_WINDOWS=$(ls -1 "$SURGE_DIR"/surge-errors-*.json 2>/dev/null | wc -l | tr -d ' ')
else
  SURGE_WINDOWS=0
  # 2026-10-13：此前这里只打印 warning 就继续写 manifest 并以 **exit 0** 结束 ⇒
  # "surge 窗口一份都没采到"在退出码上不可见。判据与上游门禁同族：**没做成就要非 0**，
  # 除非调用方显式接受降级。
  if [ "${NETWORK_OBSERVE_ALLOW_DEGRADED:-0}" = "1" ]; then
    echo "warning: surge-ai-window capture failed（已显式允许降级 NETWORK_OBSERVE_ALLOW_DEGRADED=1）" >&2
  else
    echo "FAIL: surge-ai-window 采集失败（Surge 关着或脚本缺失）—— 不写 manifest，避免把降级当成功" >&2
    exit 1
  fi
fi

cat > "$DST_ROOT/bridge-manifest.json" <<EOF
{
  "syncedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "$SRC_ROOT",
  "sourceNewestSnapshot": "$SRC_NEWEST_ISO",
  "sourceAgeSeconds": $SRC_AGE_S,
  "keep": $KEEP,
  "reportCount": $REPORT_COUNT,
  "snapshotCount": $SNAPSHOT_COUNT,
  "surgeWindowCount": $SURGE_WINDOWS,
  "latestReport": "$LATEST_REPORT",
  "latestSnapshot": "$LATEST_SNAPSHOT"
}
EOF

# 竞态可见化：syncedAt 应当**晚于** sourceNewestSnapshot；否则就是"桥跑在源之前"。
if [[ "$(date -u +%Y-%m-%dT%H:%M:%SZ)" < "$SRC_NEWEST_ISO" ]]; then
  echo "warning: 桥跑在源之前（syncedAt < sourceNewestSnapshot=$SRC_NEWEST_ISO）—— 竞态已发生，下次桥接会补上" >&2
fi

echo "bridged $REPORT_COUNT reports, $SNAPSHOT_COUNT snapshots, $SURGE_WINDOWS surge windows -> $DST_ROOT (source newest=$SRC_NEWEST_ISO, age=${SRC_AGE_S}s)"
