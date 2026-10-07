#!/bin/bash
# windows-service.sh — Windows 执行器节点的部署驱动
#
# 为什么需要独立驱动：Windows 上没有 bash/tar/systemd 语义 —— 传输要用
# C:\Windows\system32\tar.exe，服务用 PowerShell 的 Restart-Service，`.env` 也只能追加。
# tools/deploy-to-remote.sh 面向 Linux（`sh -c` + systemd），硬塞 Windows 只会两边都变形。
#
# 驱动只做**节点侧**的三件事，其余（drain / 收敛判定 / promote / 写 target_version）由
# tools/los-fleet-rollout.sh 负责 —— 单一职责，避免再次出现"两套实现"。
#
# 用法（由编排器调用）：
#   windows-service.sh sync     <ssh_alias> <remote_home> <target_version> [node_id]
#   windows-service.sh activate <ssh_alias> <remote_home> <target_version> [node_id]
#   windows-service.sh verify   <ssh_alias> <remote_home> <target_version> [node_id]
set -uo pipefail

SUB="${1:?subcommand required (sync|activate|verify)}"
ALIAS="${2:?ssh alias required}"
HOME_DIR="${3:-C:/los}"
TARGET="${4:-}"
NODE_ID="${5:-$ALIAS}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSHO=(-o BatchMode=yes -o ConnectTimeout=20 -o ControlPath=none -o ControlMaster=no)
WIN_HOME="${HOME_DIR//\//\\}"          # C:/los -> C:\los
PROBE='packages\agent\src\scheduler\executor-client.ts'   # 每次下发都应存在的节点侧文件

log() { printf '[win:%s] %s\n' "$NODE_ID" "$*"; }
die() { printf '[win:%s] FATAL: %s\n' "$NODE_ID" "$*" >&2; exit 1; }

ps() { # 通过 stdin 传 PowerShell 脚本（今晚验证过三次的调用方式）
  ssh "${SSHO[@]}" "$ALIAS" 'powershell -NoProfile -Command -' 2>&1
}

case "$SUB" in
  sync)
    [[ -n "$TARGET" ]] || die "sync needs a target version"
    # 打包复用工具的 tarball 子命令 —— 与 Linux 下发**完全相同的文件选择**，
    # 不在这里写第四份清单。
    OUT="$(bash "$ROOT/tools/deploy-to-remote.sh" tarball "/tmp/win-ship-$NODE_ID.tar.gz" | tail -1)"
    TAR_PATH="${OUT%% *}"; TAR_SHA="${OUT##* }"
    [[ -f "$TAR_PATH" ]] || die "tarball build failed"
    log "tarball ok (sha ${TAR_SHA:0:12})"
    scp "${SSHO[@]}" "$TAR_PATH" "$ALIAS:$HOME_DIR/win-ship.tar.gz" >/dev/null 2>&1 \
      || die "scp failed"
    log "uploaded"
    ps <<EOF | grep -E "^(extracted|stamped|probe=)" || die "remote extraction failed"
\$ErrorActionPreference='Stop'
& C:\Windows\system32\tar.exe -xzf "$WIN_HOME\\win-ship.tar.gz" -C "$WIN_HOME"
Write-Output "extracted"
(Get-Content "$WIN_HOME\\.env") | Where-Object { \$_ -notmatch '^(LOS|EXECUTOR)_VERSION=' } | Set-Content "$WIN_HOME\\.env" -Encoding ASCII
Add-Content "$WIN_HOME\\.env" -Value "LOS_VERSION=$TARGET" -Encoding ASCII
Add-Content "$WIN_HOME\\.env" -Value "EXECUTOR_VERSION=$TARGET" -Encoding ASCII
Write-Output "stamped"
Write-Output ("probe=" + (Test-Path "$WIN_HOME\\$PROBE"))
EOF
    ;;
  activate)
    ps <<'EOF' | grep -E "^svc=" || die "restart failed"
$ErrorActionPreference='Stop'
Restart-Service los-executor -Force
Start-Sleep -Seconds 12
Write-Output ("svc=" + (Get-Service los-executor).Status)
EOF
    ;;
  verify)
    # 只断言**节点侧可观测量**：服务在跑、.env 已盖章为目标、新代码确实落盘。
    # "版本是否等于目标"的权威判据是注册表（节点心跳上报），由编排器在 promote 前后复核。
    ps <<EOF | tee /tmp/win-verify-$NODE_ID.txt | grep -E "^(svc|stamped|probe)=" >/dev/null || die "verify failed"
\$ErrorActionPreference='Stop'
Write-Output ("svc=" + (Get-Service los-executor).Status)
\$v = (Select-String -Path "$WIN_HOME\\.env" -Pattern '^LOS_VERSION=(.+)$').Matches.Groups[1].Value
Write-Output ("stamped=" + \$v)
Write-Output ("probe=" + (Test-Path "$WIN_HOME\\$PROBE"))
EOF
    grep -q 'svc=Running' /tmp/win-verify-$NODE_ID.txt || die "service is not Running"
    grep -q "stamped=$TARGET" /tmp/win-verify-$NODE_ID.txt || die ".env is not stamped with $TARGET"
    grep -q 'probe=True' /tmp/win-verify-$NODE_ID.txt || die "content probe missing (new code did not land)"
    log "verify ok (service Running, .env=$TARGET, probe present)"
    ;;
  *) die "unknown subcommand '$SUB'" ;;
esac
