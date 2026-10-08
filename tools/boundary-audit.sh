#!/usr/bin/env bash
# boundary-audit.sh — 边界违规的一次性只读盘点（ADR 0047 判据 J1–J10 的证据面）。
#
# 为什么需要它：边界判据分散在 10 条规则里，靠人逐条记会漏；本脚本一次跑出
# 全部证据，**只读、不改任何东西**，输出可直接贴进报告或喂给日报。
#
# 纪律：
#   · 全程只读（不写文件、不启停服务、不改配置）
#   · 每项都打印**判据**与**证据**；无法判定时打印 SKIP 并说明原因（不得静默略过）
#   · 退出码：0 = 无 ERROR 级发现；1 = 有 ERROR 级发现
#
# 用法：
#   bash tools/boundary-audit.sh            # 全量
#   bash tools/boundary-audit.sh --quiet    # 只打印 ERROR/WARN 汇总
set -uo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

WS="/Users/echerlos/syncfolder/project"
LOS="$WS/los-workspace/projects/los"
DSFOLDER="$WS/dsfolder"
ERRORS=0
WARNS=0

# 颜色：NO_COLOR 或 stdout 非 tty 时禁用（日报会捕获输出，带 ANSI 会污染 markdown）
if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
  C_RESET=''; C_HEAD=''; C_OK=''; C_WARN=''; C_ERR=''; C_SKIP=''
else
  C_RESET='\033[0m'; C_HEAD='\033[1;36m'; C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_SKIP='\033[90m'
fi
hdr()  { [ "$QUIET" = 1 ] || printf "\n${C_HEAD}── %s ──${C_RESET}\n" "$1"; }
ok()   { [ "$QUIET" = 1 ] || printf "  ${C_OK}OK${C_RESET}   %s\n" "$1"; }
warn() { WARNS=$((WARNS+1)); printf "  ${C_WARN}WARN${C_RESET} %s\n" "$1"; }
err()  { ERRORS=$((ERRORS+1)); printf "  ${C_ERR}ERR${C_RESET}  %s\n" "$1"; }
info() { [ "$QUIET" = 1 ] || printf '  ..   %s\n' "$1"; }
skip() { printf "  ${C_SKIP}SKIP${C_RESET} %s\n" "$1"; }

# grep 辅助：统计命中数（无命中返回 0）
count_matches() { # <pattern> <path...>
  local pat="$1"; shift
  grep -rIl -E "$pat" "$@" 2>/dev/null | wc -l | tr -d ' '
}

printf '\033[1mboundary-audit\033[0m — ADR 0047 边界判据证据面（只读）\n'
printf '时间: %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"

# ─────────────────────────────────────────────────────────────
hdr "J3 · L0 全局规则纯洁性（~/.codex/rules 不得含项目端口/路径/项目名）"
# 判据：逐字删除项目名与端口后规则仍应成立 ⇒ 出现即 ERROR
L0_TARGETS=( "$HOME/.codex/AGENTS.md" )
while IFS= read -r -d '' f; do L0_TARGETS+=("$f"); done < <(find "$HOME/.codex/rules" -name '*.md' -print0 2>/dev/null)
L0_HITS=$(count_matches 'cantool|cankey|canpad|los-workspace|dsfolder|lzlyx|wechatdp|lot2extension|:8080|:8090|:18011|:3080' "${L0_TARGETS[@]}")
if [ "$L0_HITS" = "0" ]; then ok "L0 无项目端口/路径/项目名（${#L0_TARGETS[@]} 个文件）"
else
  err "L0 出现项目标识符：$L0_HITS 个文件"
  grep -rIl -E 'cantool|cankey|canpad|los-workspace|dsfolder|lzlyx|wechatdp|lot2extension|:8080|:8090|:18011|:3080' "${L0_TARGETS[@]}" 2>/dev/null | sed 's/^/       /'
fi

# ─────────────────────────────────────────────────────────────
hdr "J2 · 引用方向（tool 层不得知道项目）"
# 判据分两级（2026-10-08 实测收窄：过宽判据会制造噪音，与"假红"同型）：
#   ERR  = 硬编码本机项目**绝对路径**（测试夹具/默认值）⇒ 不可移植且把项目带进工具层
#   INFO = 注释/文档/help 示例里的项目名（无害）
HARD_PATH_RE='/Users/echerlos/(syncfolder|syncthing|Downloads)/projects/(cantool|cankey|canpad|dsfolder|lot2extension|wechatdp|lzlyx|los-workspace)'
NAME_RE='cantool|cankey|lot2extension|wechatdp|lzlyx'
for t in unirun rustopt fmtguard sandbox-run verify-gate session-index routeguard; do
  d="$DSFOLDER/$t"
  [ -d "$d/src" ] || { skip "$t 无 src/"; continue; }
  hard=$(grep -rIl -E "$HARD_PATH_RE" "$d/src" 2>/dev/null | wc -l | tr -d ' ')
  soft=$(grep -rIl -E "$NAME_RE" "$d/src" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$hard" != "0" ]; then
    err "$t src/ 硬编码本机项目路径：$hard 个文件"
    grep -rIn -E "$HARD_PATH_RE" "$d/src" 2>/dev/null | head -4 | sed 's/^/       /'
  elif [ "$soft" != "0" ]; then
    info "$t src/ 仅注释/示例含项目名（$soft 个文件，无害）"
    ok "$t src/ 无硬编码项目路径"
  else
    ok "$t src/ 无项目引用"
  fi
done

hdr "J10 / R6 · 无 VCS 的代码目录（registry-aware）"
# 判据：有 manifest 但无 VCS ⇒ 必须**已在 projects.json 登记豁免**（vcsExemptReason 或 kind=archived）。
# 未登记者才是 ERR —— 已登记者只报提示，避免审计与登记表自相矛盾。
REG="$WS/los-workspace/.workspace/projects.json"
REG_KEYS=""
if [ -f "$REG" ]; then
  REG_KEYS=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
for p in d.get('projects',[]):
    for e in [p]+list(p.get('children') or []):
        if e.get('vcs')=='none' and (e.get('vcsExemptReason') or e.get('kind')=='archived'):
            print(e['key'])
" "$REG" 2>/dev/null)
  info "registry 豁免名单: $(printf '%s' "$REG_KEYS" | tr '\n' ' ')"
else skip "projects.json 不存在"; fi

NO_VCS=0; EXEMPT=0
for d in "$DSFOLDER"/*/; do
  name=$(basename "$d")
  case "$name" in scripts|tmp|~|.*) continue;; esac
  has_manifest=0
  for m in Cargo.toml package.json go.mod pyproject.toml; do [ -f "$d/$m" ] && has_manifest=1; done
  [ "$has_manifest" = "1" ] || continue
  [ -d "$d/.git" ] || [ -d "$d/.jj" ] && continue
  if printf '%s\n' "$REG_KEYS" | grep -qx "$name"; then
    EXEMPT=$((EXEMPT+1)); info "$name 无 VCS 但已在 projects.json 登记豁免"
  else
    NO_VCS=$((NO_VCS+1)); err "$name 有 manifest 但无 VCS **且未登记豁免**（J10 违规）"
  fi
done
[ "$NO_VCS" = "0" ] && ok "无未登记的 no-VCS 目录（已登记豁免 $EXEMPT 个）"

# 父仓的未跟踪脚本（2026-10-08 实测踩到：修复活在未跟踪文件里）
UNTRACKED=$(cd "$DSFOLDER" && git ls-files --others --exclude-standard scripts/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$UNTRACKED" = "0" ]; then ok "dsfolder/scripts 无未跟踪文件"
else warn "dsfolder/scripts 有 $UNTRACKED 个未跟踪文件（改动不可追溯）"; fi

# ─────────────────────────────────────────────────────────────
hdr "J1 · 能力归属表与门禁"
if [ -f "$LOS/docs/governance/capability-ownership.yaml" ]; then
  if (cd "$LOS" && pnpm exec node tools/check-capability-ownership.mjs >/dev/null 2>&1); then
    ok "capability-ownership.yaml 校验通过"
  else err "capability-ownership.yaml 校验失败（跑 pnpm check:capability-ownership 看详情）"; fi
else err "capability-ownership.yaml 缺失"; fi

if [ -f "$WS/los-workspace/.workspace/projects.json" ]; then
  if (cd "$LOS" && node tools/check-project-registry.mjs >/dev/null 2>&1); then
    ok "projects.json 校验通过"
  else err "projects.json 校验失败（跑 pnpm check:project-registry 看详情）"; fi
else err "projects.json 缺失"; fi

# ─────────────────────────────────────────────────────────────
hdr "J8 · 模型路由：配置 vs 生效 vs owner"
if (cd "$LOS" && node tools/model-route-truth.mjs --check >/dev/null 2>&1); then
  ok "无路由冲突"
  (cd "$LOS" && node tools/model-route-truth.mjs 2>/dev/null | grep -E '^  verdict' | sed 's/^/     /')
else
  err "存在路由冲突："
  (cd "$LOS" && node tools/model-route-truth.mjs --check 2>&1 | tail -3 | sed 's/^/       /')
fi

# ─────────────────────────────────────────────────────────────
hdr "R1 · provider 写者（los 不得代改 DSH 默认模型）"
DSH_PATCH="$HOME/.dsh/profiles/desktop/cordis.patch.yml"
if [ -f "$DSH_PATCH" ]; then
  if grep -q 'id: agent-default-model' "$DSH_PATCH"; then
    prov=$(grep -A3 'id: agent-default-model' "$DSH_PATCH" | grep -m1 'provider:' | awk '{print $2}')
    info "DSH agent-default-model.provider = ${prov:-?}（owner=DSH，los 不得代改）"
    ok "DSH 默认模型存在且由 DSH 自己声明"
  else warn "DSH patch 里没有 agent-default-model（DSH 可能未配默认模型）"; fi
else skip "$DSH_PATCH 不存在"; fi

# ─────────────────────────────────────────────────────────────
hdr "J7 · 投影新鲜度与 canonical 标注"
IDX="$HOME/.dsh/storages/session-index.db"
if [ -f "$IDX" ]; then
  AGE_H=$(( ( $(date +%s) - $(stat -f %m "$IDX") ) / 3600 ))
  if [ "$AGE_H" -le 6 ]; then ok "session-index.db ${AGE_H}h 前更新（阈值 6h）"
  else warn "session-index.db 已 ${AGE_H}h 未更新（launchd com.echerlos.dsh-session-index 可能停了）"; fi
  # canonical 声明必须在 README 里（投影可丢弃、session log 是 canonical）
  if grep -qi 'projection is disposable' "$DSFOLDER/session-index/README.md" 2>/dev/null; then
    ok "session-index README 声明了 canonical 源"
  else warn "session-index 未在 README 里声明 canonical 源"; fi
else skip "session-index.db 不存在"; fi

# ─────────────────────────────────────────────────────────────
hdr "X6 · 两份互相矛盾的权威"
TM="$LOS/docs/governance/toolchain-matrix.md"
DSDOC="$DSFOLDER/RUST-REPO-LOS-GOVERNANCE-DESIGN-2026-10-07.md"
if [ -f "$TM" ] && [ -f "$DSDOC" ]; then
  if grep -qE 'runs\.jsonl' "$DSDOC" 2>/dev/null && ! grep -qE 'runs\.jsonl' "$TM" 2>/dev/null; then
    warn "toolchain-matrix 未提 runs.jsonl 归属，而 dsfolder 设计稿把它当可引用外部证据 ⇒ 归属规则仍待收口（B0.2 已建表，需把两处对齐）"
  else info "X6 两处表述已一致或其一缺失"; fi
else skip "X6 引用文档缺失"; fi

# ─────────────────────────────────────────────────────────────
hdr "孤儿入口（有实现、无消费者）"
# los mcp serve 的消费者面 = 三个宿主的配置（Codex / Claude / DSH）；**只看 DSH 会误报**。
# 2026-10-08 修正：原先只查 session-index 的调用次数 ⇒ 接线后仍报"零消费者"（假红）。
CODEX_CFG="$HOME/.codex/config.toml"
CLAUDE_CFG="$HOME/.claude.json"
DSH_PATCHES=$(ls "$HOME"/.dsh/profiles/*/cordis.patch.yml 2>/dev/null)
hosts=()
grep -q '^\[mcp_servers\.los\]' "$CODEX_CFG" 2>/dev/null && hosts+=("codex")
grep -q '"los"' "$CLAUDE_CFG" 2>/dev/null && hosts+=("claude")
[ -n "$DSH_PATCHES" ] && grep -lq 'los-mcp\|los_mcp\|"los"' $DSH_PATCHES 2>/dev/null && hosts+=("dsh")
if [ "${#hosts[@]}" -gt 0 ]; then
  ok "los mcp serve 已在宿主配置中接线: ${hosts[*]}"
else
  warn "los mcp serve 未在任何宿主配置中接线（codex/claude/dsh 均无）"
fi
# 实际调用证据（跨会话计数；接线后需要真实会话调用过才算"用起来"）
LOS_MCP_CALLS=$(# 不加 -readonly：对缺失 -shm 的 WAL 库会以 (14) 失败（只跑 SELECT，不写）
sqlite3 "$IDX" "SELECT count(*) FROM events WHERE kind='tool/call' AND name IN ('los_run','los_run_state','los_run_replay','los_operator_control');" 2>/dev/null || echo "?")
case "$LOS_MCP_CALLS" in
  0) info "全历史 MCP 调用次数=0（已接线但尚无真实调用 —— 需真实会话跑一次才算闭环）";;
  "?") skip "无法查询 session-index";;
  *) ok "los mcp serve 有 $LOS_MCP_CALLS 次调用";;
esac

printf "\n${C_HEAD}汇总${C_RESET}: ERROR=%d WARN=%d\n" "$ERRORS" "$WARNS"
[ "$ERRORS" = "0" ] && printf '边界盘点：无 ERROR 级发现\n' || printf '边界盘点：有 %d 项 ERROR，需处理\n' "$ERRORS"
exit $([ "$ERRORS" = "0" ] && echo 0 || echo 1)
