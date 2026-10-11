#!/bin/bash
# macos-launchd.sh — macOS 执行器节点的驱动（launchd + **钉树**）
#
# 为什么需要它：macOS 节点的执行器从一棵固定的树运行（`~/.local/share/los`，tar/内容同步的产物），
# 由自己的 launchd 标签托管，**与网关分开**。此前这段逻辑内联在编排器里（
# `tools/los-fleet-rollout.sh` 的 macos 分支），既不可单独评审，也无法给"本机节点"复用 ——
# 而 mbp-executor-1 在 2026-10-11 之前是直接从**可编辑的 checkout** 运行的：
#   · 身份 = "编辑器此刻的样子"（/health 报的是进程启动时算的摘要，而 tsx 按需从磁盘加载模块
#     ⇒ 未提交改动可以不重启就进入执行路径）；
#   · 滚动它 = `los.sh restart` 连网关一起弹（两者共用同一棵树）。
# 现在两个 macOS 节点（mbp-executor-1 与 m3pro-executor-1）**配置完全一致**：
# 同样的 home、同样的标签、同样的重启方式 —— 本驱动对两者是同一套调用。
#
# 用法（编排器调用；也可手工用）：
#   macos-launchd.sh install-plist <home> <label> [node_bin]
#   macos-launchd.sh activate      <home> <label>
#   macos-launchd.sh verify        <home> <label> <target_version>
#   macos-launchd.sh digest        <home>
#   macos-launchd.sh status        <home> <label>
set -uo pipefail

SUB="${1:?subcommand required (install-plist|activate|verify|digest|status)}"
HOME_DIR="${2:?node home required (e.g. /Users/x/.local/share/los)}"
LABEL="${3:-com.echerlos.los-executor}"
TARGET="${4:-}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

log()  { printf '[macos:%s] %s\n' "$LABEL" "$*"; }
die()  { printf '[macos:%s] FATAL: %s\n' "$LABEL" "$*" >&2; exit 1; }

# launchd 环境不含用户 shell 的 fnm/homebrew/cargo 路径；与 los-launchd-wrapper.sh 同样的理由：
# 执行器 spawn 的子进程（门禁里的 cargo、pnpm 等）会继承 PATH，缺一项就会被记成"真实漂移"。
node_bin() {
  local explicit="${1:-}"
  if [ -n "$explicit" ]; then printf '%s' "$explicit"; return; fi
  # fnm 的 default 别名是稳定路径（multishell 路径是每个 shell 一份、会消失）
  local candidates=(
    "$HOME/Library/Application Support/fnm/aliases/default/bin/node"
    "$HOME/.local/bin/node"
    /opt/homebrew/bin/node
    /usr/local/bin/node
  )
  local c
  for c in "${candidates[@]}"; do [ -x "$c" ] && { printf '%s' "$c"; return; }; done
  command -v node || true
}

launchd_path() {
  printf '%s' "$HOME/.cargo/bin:$HOME/Library/pnpm:$HOME/Library/Application Support/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

executor_health_version() { # 从节点的 .env 取端口，读它自己的 /health
  local port
  port="$(sed -n 's/^EXECUTOR_PORT=//p' "$HOME_DIR/.env" 2>/dev/null | tr -d '[:space:]')"
  port="${port:-8090}"
  curl -s -m 8 "http://127.0.0.1:$port/health" 2>/dev/null \
    | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1
}

case "$SUB" in
  install-plist)
    NODE_BIN="$(node_bin "${4:-}")"
    [ -n "$NODE_BIN" ] || die "cannot find a node binary"
    TSX="$HOME_DIR/packages/executor/node_modules/tsx/dist/cli.mjs"
    ENTRY="$HOME_DIR/packages/executor/src/index.ts"
    [ -f "$TSX" ] || die "tsx not found at $TSX — run the install step first"
    [ -f "$ENTRY" ] || die "executor entry not found at $ENTRY"
    mkdir -p "$HOME_DIR/.los-runtime" "$HOME/Library/LaunchAgents"
    # 生成而不是"下发一份 plist 文件"：plist 里的路径随节点与用户而异，而驱动本身在摘要
    # 排除面内（tools/deploy-drivers/*）⇒ 新增/修改它不会移动机队目标。
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 由 tools/deploy-drivers/macos-launchd.sh install-plist 生成；勿手工编辑（改动会在下次滚动被覆盖）。 -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$TSX</string>
    <string>$ENTRY</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$(launchd_path)</string>
  </dict>
  <key>StandardOutPath</key><string>$HOME_DIR/.los-runtime/executor-launchd.out.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/.los-runtime/executor-launchd.err.log</string>
</dict>
</plist>
PLIST_EOF
    plutil -lint "$PLIST" >/dev/null || die "generated plist is not valid: $PLIST"
    log "plist written: $PLIST (node=$NODE_BIN)"
    ;;
  activate)
    [ -f "$PLIST" ] || die "plist missing: $PLIST (run install-plist first)"
    # bootout 是幂等的：没加载时返回非零，忽略即可。但**后续步骤的错误必须留住** ——
    # 把 launchctl 的 stderr 丢进 /dev/null 会让滚动只报一句"FAILED to converge"，
    # 而真正原因（例如"服务已加载"/plist 被重写后未重读）无从得知（2026-10-11 实测）。
    bootout_err="$(launchctl bootout "gui/$(id -u)/$LABEL" 2>&1)" || true
    # bootout 是**异步**的：紧接着 bootstrap 可能撞上"正在卸载"。所以先轮询到卸载完成，再加载。
    for _ in $(seq 1 10); do
      launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
      sleep 1
    done
    if ! bootstrap_err="$(launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>&1)"; then
      if ! kickstart_err="$(launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>&1)"; then
        printf '[macos:%s] launchctl bootout: %s\n' "$LABEL" "${bootout_err:-<none>}" >&2
        printf '[macos:%s] launchctl bootstrap: %s\n' "$LABEL" "${bootstrap_err:-<none>}" >&2
        printf '[macos:%s] launchctl kickstart: %s\n' "$LABEL" "${kickstart_err:-<none>}" >&2
        die "cannot load or kickstart $LABEL"
      fi
    fi
    log "activated $LABEL"
    ;;
  verify)
    [ -n "$TARGET" ] || die "verify needs a target version"
    # ① 内容：节点自己的摘要
    digest="$(bash "$HOME_DIR/tools/los.sh" build-version 2>/dev/null | tail -1)"
    [ "$digest" = "$TARGET" ] || die "content digest '$digest' != target '$TARGET'"
    # ② 进程：它自己的 /health 必须报出目标（注册表心跳会滞后，不能单独当证据）
    # 冷启动要留够：内容换过之后第一次起执行器，node + tsx（按需编译 TS）+ 连库实测可以到
    # 30–60s（2026-10-11 首次滚动就因此判过一次失败，第二次已就绪便通过）。这里给 120s，
    # 与 runbook 里 systemd 的 90s 宽限同量级，且**不**掩盖 failed/版本错这些真信号。
    seen="none"
    for _ in $(seq 1 24); do
      seen="$(executor_health_version)"
      [ "$seen" = "$TARGET" ] && break
      sleep 5
    done
    [ "$seen" = "$TARGET" ] || die "/health never reported $TARGET (got '$seen') — the job is loaded but not serving; check $HOME_DIR/.los-runtime/executor-launchd.err.log"
    log "verify ok (digest=$digest, /health=$seen)"
    ;;
  digest)
    bash "$HOME_DIR/tools/los.sh" build-version 2>/dev/null | tail -1
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "^\s+(state|pid|runs) =" || echo "(job not loaded)"
    printf 'digest=%s health=%s\n' \
      "$(bash "$HOME_DIR/tools/los.sh" build-version 2>/dev/null | tail -1)" \
      "$(executor_health_version)"
    ;;
  *) die "unknown subcommand '$SUB'" ;;
esac
