#!/bin/bash
# windows-service.sh — Windows 执行器节点的部署驱动
#
# 为什么需要独立驱动：Windows 上没有 bash/tar/systemd 语义 —— 传输要用
# C:\Windows\system32\tar.exe，服务用 PowerShell 的 Restart-Service，`.env` 也只能追加。
# tools/deploy-to-remote.sh 面向 Linux（`sh -c` + systemd），硬塞 Windows 只会两边都变形。
#
# 驱动只做**节点侧**的四件事，其余（drain / 收敛判定 / promote / 写 target_version）由
# tools/los-fleet-rollout.sh 负责 —— 单一职责，避免再次出现"两套实现"。
#
# 用法（由编排器调用）：
#   windows-service.sh sync     <ssh_alias> <remote_home> <target_version> [node_id]
#   windows-service.sh install  <ssh_alias> <remote_home> <target_version> [node_id]
#   windows-service.sh digest   <ssh_alias> <remote_home> [ignored] [node_id]
#   windows-service.sh activate <ssh_alias> <remote_home> <target_version> [node_id]
#   windows-service.sh verify   <ssh_alias> <remote_home> <target_version> [node_id]
set -uo pipefail

SUB="${1:?subcommand required (sync|install|digest|activate|verify)}"
ALIAS="${2:?ssh alias required}"
HOME_DIR="${3:-C:/los}"
TARGET="${4:-}"
NODE_ID="${5:-$ALIAS}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSHO=(-o BatchMode=yes -o ConnectTimeout=20 -o ControlPath=none -o ControlMaster=no)
WIN_HOME="${HOME_DIR//\//\\}"          # C:/los -> C:\los
WIN_TMP='C:/Windows/Temp'
PROBE='packages\agent\src\scheduler\executor-client.ts'   # 每次下发都应存在的节点侧文件
# pnpm 版本的唯一真源是仓库自己的 packageManager 字段（`pnpm@11.6.0`），不在这里再写一个数。
PNPM_PIN="$(node -p "require('$ROOT/package.json').packageManager" 2>/dev/null | sed -n 's/^pnpm@//p')"
SYNC_OUT="/tmp/win-sync-$NODE_ID.txt"
INSTALL_OUT="/tmp/win-install-$NODE_ID.txt"
VERIFY_OUT="/tmp/win-verify-$NODE_ID.txt"

log() { printf '[win:%s] %s\n' "$NODE_ID" "$*"; }
die() { printf '[win:%s] FATAL: %s\n' "$NODE_ID" "$*" >&2; exit 1; }

# win_quote <args...> —— 按 cmd.exe 规则给每个参数加**双引号**。
# 不能用单引号：cmd.exe 不认单引号（PowerShell 认，cmd 不认），参数会原样带着引号传进去，
# 于是 `param([string]$WinHome)` 拿到的是 "'C:\los'" 这种值，再拼 `"$WinHome\.env"` 就被
# PowerShell 当成"在 C: 驱动器上找相对路径"（实测报 DriveNotFoundException）。
win_quote() {
  local out="" a
  for a in "$@"; do out="$out \"$a\""; done
  printf '%s' "$out"
}

# ps_script <name> [args...] —— 从 stdin 读 PowerShell 脚本，**上传后以 -File 执行**。
#
# 为什么不用 `powershell -Command -` 或 `-EncodedCommand`（两者都实测踩过）：
#   * `-Command -` 以**逐行**方式执行 stdin，跨行的块（if/for/try）在块首之后被静默丢弃，
#     不报错也不继续（实测：一个跨行 foreach 只打印了块前那一行）；
#   * `-EncodedCommand` 把脚本塞进命令行，一旦脚本带中文注释就超过 cmd.exe 的 8191 字符上限，
#     远端只回一句"命令行太长"（base64 + UTF-16LE 让体积再翻一倍多）。
# 上传执行还顺带消掉了 heredoc 的两类隐形陷阱：正文里出现反引号会被**本地** shell 当命令替换
# 执行，注释里的美元号会被本地 `set -u` 当变量展开（本次两处都踩过）。现在正文用**加引号**的
# heredoc 原样传输，变量改成 `param()` 传参。
ps_script() {
  local name="$1"; shift
  local local_ps="/tmp/los-win-$NODE_ID-$name.ps1"
  local remote_ps="$WIN_TMP/los-$name.ps1"
  local remote_win="${remote_ps//\//\\}"
  # 必须写 **UTF-8 BOM**：Windows PowerShell 5.1 在没有 BOM 时按系统 ANSI 代码页（本机是 GBK）
  # 读 .ps1，脚本里的中文注释会被解成乱码并吃掉后面的引号/大括号，表现为莫名其妙的
  # ParserError（实测：唯一带中文注释的 install.ps1 报 `}` 意外，而同为 ASCII 的 sync/verify 正常）。
  printf '\xEF\xBB\xBF' > "$local_ps"
  cat >> "$local_ps"
  scp "${SSHO[@]}" "$local_ps" "$ALIAS:$remote_ps" >/dev/null 2>&1 \
    || die "cannot upload $name.ps1 to $ALIAS:$remote_ps"
  # shellcheck disable=SC2029  # 远程展开是有意的：$@ 已用 win_quote 处理
  ssh "${SSHO[@]}" "$ALIAS" "powershell -NoProfile -ExecutionPolicy Bypass -File \"$remote_win\"$(win_quote "$@")" 2>&1
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
    # PowerShell 输出 CRLF，落盘前统一去 CR —— 否则 `^marker$` 这类锚定断言永远不匹配。
    # LC_ALL=C：PowerShell 的 CLIXML 错误文本可能是本地代码页（GBK），UTF-8 locale 下的 tr
    # 会以 "Illegal byte sequence" 直接失败。
    ps_script sync "$WIN_HOME" "$TARGET" "$PROBE" <<'POWERSHELL' | LC_ALL=C tr -d '\r' | tee "$SYNC_OUT" >/dev/null
param([string]$WinHome, [string]$Target, [string]$Probe)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
& C:\Windows\system32\tar.exe -xzf "$WinHome\win-ship.tar.gz" -C $WinHome
Write-Output "extracted"
(Get-Content "$WinHome\.env") | Where-Object { $_ -notmatch '^(LOS|EXECUTOR)_VERSION=' } | Set-Content "$WinHome\.env" -Encoding ASCII
Add-Content "$WinHome\.env" -Value "LOS_VERSION=$Target" -Encoding ASCII
Add-Content "$WinHome\.env" -Value "EXECUTOR_VERSION=$Target" -Encoding ASCII
Write-Output "stamped"
Write-Output ("probe=" + (Test-Path "$WinHome\$Probe"))
POWERSHELL
    # **逐个标记**断言，而不是原来的 `grep -E "^(extracted|stamped|probe=)"`：那个判据只要
    # 命中**任意一行**就算成功，于是"解包成功但盖章/探针没跑到"会被判成成功 —— 然后在节点上
    # 留下"`.env` 是新的、代码是旧的"这种最难查的状态（2026-10-06 srsbe20 就是这么来的）。
    grep -q '^extracted$' "$SYNC_OUT" || die "remote extraction failed (see $SYNC_OUT)"
    grep -q '^stamped$' "$SYNC_OUT" || die "version stamp failed (see $SYNC_OUT)"
    grep -q '^probe=True$' "$SYNC_OUT" || die "content probe missing: $PROBE did not land (see $SYNC_OUT)"
    log "sync ok (extracted, stamped=$TARGET, probe present)"

    # 剪枝：删掉"节点上有、这次清单里没有"的源文件。
    #
    # 为什么必须有：tar 只添加/覆盖，**从不删除**。Linux 侧一直有这一步，Windows 侧没有，
    # 于是两台 Windows 节点各自积了不同批次的陈旧文件（被上游删除的源文件，外加有人手工解开的
    # nssm 源码树 —— 实测 win-los 45 个）。后果不是"多占几 MB"：内容摘要覆盖每个源文件，
    # 所以节点的内容**永远不等于**目标。以前 Windows 没有摘要，这件事完全不可见；
    # 2026-10-11 摘要落地后，两台节点立刻报出各自不同、且都不等于目标的 digest。
    # 清单来自 tar 自己（`deploy-to-remote.sh tarball` 落下的 `*.list`），不可能与包内容漂移。
    scp "${SSHO[@]}" "$TAR_PATH.list" "$ALIAS:$WIN_TMP/los-shipped.list" >/dev/null 2>&1 \
      || die "cannot upload the shipped manifest"
    ps_script prune "$WIN_HOME" 'C:\Windows\Temp\los-shipped.list' <<'POWERSHELL' | LC_ALL=C tr -d '\r' | tee "/tmp/win-prune-$NODE_ID.txt"
param([string]$WinHome, [string]$ListPath)
$ErrorActionPreference='Continue'
$ProgressPreference='SilentlyContinue'
$shipped = @(Get-Content $ListPath | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
Write-Output ("shipped=" + $shipped.Count)
if ($shipped.Count -eq 0) { Write-Output "prune=SKIP (empty manifest, deleting nothing)"; exit 0 }
$keep = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
foreach ($s in $shipped) { [void]$keep.Add($s) }
# 与 Linux 侧剪枝的 find 保持同一套剪枝目录与排除项
$prunedDirs = @('node_modules','dist','.turbo','.los','.los-runtime')
$present = New-Object 'System.Collections.Generic.List[string]'
foreach ($tree in @('tools','deploy','packages','contracts')) {
  $base = Join-Path $WinHome $tree
  if (-not (Test-Path $base)) { continue }
  foreach ($f in (Get-ChildItem -LiteralPath $base -Recurse -File -Force -ErrorAction SilentlyContinue)) {
    $parts = $f.FullName.Substring($WinHome.Length + 1) -split '[\\/]'
    $skip = $false
    foreach ($p in $parts) { if ($prunedDirs -contains $p) { $skip = $true; break } }
    if ($skip) { continue }
    if ($f.Name.EndsWith('.tsbuildinfo')) { continue }
    $present.Add(($parts -join '/'))
  }
}
Write-Output ("present=" + $present.Count)
$stale = @($present | Where-Object { -not $keep.Contains($_) })
Write-Output ("prune=" + $stale.Count + " stale file(s) not in the shipped manifest")
if ($stale.Count -gt 500) { Write-Output "prune=ABORT (stale count exceeds 500)"; exit 1 }
# 安全轨：绝不删除已安装依赖、版本库或配置（与 Linux 侧同一条）
$unsafe = @($stale | Where-Object { $_ -match '(^|/)(node_modules|\.git|\.env)(/|$)' })
if ($unsafe.Count -gt 0) { Write-Output ("prune=ABORT unsafe path: " + $unsafe[0]); exit 1 }
$removed = 0
foreach ($rel in $stale) {
  try { Remove-Item -LiteralPath (Join-Path $WinHome ($rel -replace '/','\')) -Force -ErrorAction Stop; $removed++ }
  catch { Write-Output ("prune_keep=" + $rel) }
}
Write-Output ("prune_removed=" + $removed)
POWERSHELL
    grep -q '^prune=ABORT' "/tmp/win-prune-$NODE_ID.txt" \
      && die "stale-file prune aborted (see /tmp/win-prune-$NODE_ID.txt)"
    log "prune ok ($(grep -m1 '^prune=' "/tmp/win-prune-$NODE_ID.txt" | cut -d= -f2-), removed $(grep -m1 '^prune_removed=' "/tmp/win-prune-$NODE_ID.txt" | cut -d= -f2-))"
    ;;
  install)
    # 依赖安装。Windows 上没有 workspace 链接的自动修复：pnpm 把 workspace 包链接进
    # 各个 packages/<pkg>/node_modules/@los/，而 tar 只搬源码、node_modules 不在下发清单里。
    # 于是任何"新增/删除 workspace 包"的发布，如果不跑 install，节点就会在 nssm 下
    # ERR_MODULE_NOT_FOUND 崩溃循环（2026-10-11 实测：本轮新增 @los/mcp-stdio，
    # win-los 需要补装、srsbe20 一直没能恢复）。
    [[ -n "$PNPM_PIN" ]] || die "cannot read packageManager from $ROOT/package.json"
    ps_script install "$WIN_HOME" "$PNPM_PIN" <<'POWERSHELL' | LC_ALL=C tr -d '\r' | tee "$INSTALL_OUT"
param([string]$WinHome, [string]$PnpmPin)
$ErrorActionPreference='Continue'
$ProgressPreference='SilentlyContinue'
# 非交互 SSH 会话拿到的 PATH 可能**不含 Node**：srsbe20 实测 'C:\Program Files\nodejs' 不在
# 机器 PATH 里，但 node.exe / npm.cmd / pnpm.cmd 都在 ⇒ Get-Command 一律找不到，install 被误判
# 成"这台机器没有工具链"（上一轮把 srsbe20 记成"缺 pnpm/corepack"就是这么来的）。按约定位置补齐。
$env:Path = $env:Path + ';C:\Program Files\nodejs;' + $env:APPDATA + '\npm;' + $env:LOCALAPPDATA + '\pnpm'
# 解析到 **.cmd** 垫片再调用，不要只写 pnpm：PowerShell 的命令发现会优先命中 pnpm.ps1，
# 而非交互会话的默认执行策略拒绝运行脚本，表现是"pnpm 明明装着却什么都跑不了"。.cmd 不受限。
function Resolve-Shim([string]$Name) {
  $c = Join-Path $env:APPDATA ("npm\" + $Name + ".cmd")
  if (Test-Path $c) { return $c }
  $g = Get-Command $Name -ErrorAction SilentlyContinue
  if ($g) { return $g.Source }
  return $null
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Output "node=MISSING"; exit 1 }
Write-Output ("node=" + $node.Source)
$pnpm = Resolve-Shim 'pnpm'
if (-not $pnpm) {
  $npm = Resolve-Shim 'npm'
  if (-not $npm) { Write-Output "bootstrap=NO_NPM"; exit 1 }
  Write-Output ("bootstrap=installing pnpm@" + $PnpmPin + " via npm")
  & $npm install -g ("pnpm@" + $PnpmPin) 2>&1 | Out-String | Write-Output
  $pnpm = Resolve-Shim 'pnpm'
  if (-not $pnpm) { Write-Output "bootstrap=FAILED"; exit 1 }
}
Write-Output ("pnpm_path=" + $pnpm)
Set-Location $WinHome
& $pnpm install --frozen-lockfile 2>&1 | Out-String | Write-Output
Write-Output ("install_exit=" + $LASTEXITCODE)
POWERSHELL
    grep -q '^install_exit=0$' "$INSTALL_OUT" \
      || die "pnpm install did not succeed on the node (see $INSTALL_OUT)"
    log "install ok ($(grep -m1 '^pnpm_path=' "$INSTALL_OUT" | cut -d= -f2- || echo 'pnpm=?'), frozen-lockfile)"
    ;;
  digest)
    # 内容摘要：调用**同一个** Node 模块（`tools/deployable-content.mjs`，随 tar 一起下发）。
    # 这是 Windows 第一次有内容标识 —— 在此之前协调器只能看到 <no-response>，于是
    # (a) 每轮滚动都重跑驱动，(b) "这台到底是不是目标内容"没有判据，
    # 一台崩溃循环的节点长期被记成"已安全回退到旧版"（2026-10-11 srsbe20 现场）。
    # 设计依据：docs/architecture/2026-10-11-cross-platform-content-identity-design.md
    ps_script digest "$WIN_HOME" <<'POWERSHELL' | LC_ALL=C tr -d '\r' | grep -E '^digest='
param([string]$WinHome)
$ErrorActionPreference='Continue'
$ProgressPreference='SilentlyContinue'
# 与 install 同样的 PATH 补齐：非交互会话可能看不见 node
$env:Path = $env:Path + ';C:\Program Files\nodejs;' + $env:APPDATA + '\npm'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Output "digest=node-missing"; exit 1 }
$module = Join-Path $WinHome 'tools\deployable-content.mjs'
if (-not (Test-Path $module)) { Write-Output "digest=module-missing"; exit 1 }
Set-Location $WinHome
$out = & $node $module --digest 2>&1
Write-Output ("digest=" + ($out | Select-Object -Last 1))
POWERSHELL
    ;;
  activate)
    ps_script activate <<'POWERSHELL' | LC_ALL=C tr -d '\r' | grep -E "^svc=" || die "restart failed"
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Restart-Service los-executor -Force
Start-Sleep -Seconds 12
Write-Output ("svc=" + (Get-Service los-executor).Status)
POWERSHELL
    ;;
  verify)
    # 断言**节点侧可观测量**：服务在跑、`.env` 已盖章为目标、新代码确实落盘，
    # 以及 —— 最要紧的一条 —— 节点**自己的 /health 报出目标版本**。
    #
    # 最后这条是 2026-10-11 补的，也是本驱动此前最大的假阳性来源：nssm 下"服务 Running"
    # 与"执行器真的在服务"是两件事。进程因缺 workspace 链接 ERR_MODULE_NOT_FOUND 崩溃循环时，
    # 服务状态仍是 Running、`.env` 仍是新的、源码探针文件也仍在 ⇒ 前三条全过，
    # 于是协调器把一台**反复重启、不再心跳**的节点记成"已安全回退到旧版"
    # （srsbe20 的实际现场：注册表 offline + 旧版本，而磁盘上的 `.env` 已经是新版本）。
    # /health 是唯一能区分"服务在跑"与"代码在服务"的观测面。
    ps_script verify "$WIN_HOME" "$TARGET" "$PROBE" <<'POWERSHELL' | LC_ALL=C tr -d '\r' | tee "$VERIFY_OUT" >/dev/null
param([string]$WinHome, [string]$Target, [string]$Probe)
$ErrorActionPreference='Continue'
$ProgressPreference='SilentlyContinue'
Write-Output ("svc=" + (Get-Service los-executor).Status)
$v = (Select-String -Path "$WinHome\.env" -Pattern '^LOS_VERSION=(.+)$' | Select-Object -Last 1).Matches.Groups[1].Value
Write-Output ("stamped=" + $v)
Write-Output ("probe=" + (Test-Path "$WinHome\$Probe"))
$port = (Select-String -Path "$WinHome\.env" -Pattern '^EXECUTOR_PORT=(.+)$' | Select-Object -Last 1).Matches.Groups[1].Value
if (-not $port) { $port = '8090' }
$seen = 'none'
for ($i = 0; $i -lt 12; $i++) {
  try {
    $h = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/health") -TimeoutSec 8
    $seen = [string]$h.version
    if ($seen -eq $Target) { break }
  } catch { $seen = 'unreachable' }
  Start-Sleep -Seconds 5
}
Write-Output ("health=" + $seen)
POWERSHELL
    grep -q 'svc=Running' "$VERIFY_OUT" || die "service is not Running"
    grep -q "stamped=$TARGET" "$VERIFY_OUT" || die ".env is not stamped with $TARGET"
    grep -q 'probe=True' "$VERIFY_OUT" || die "content probe missing (new code did not land)"
    grep -q "health=$TARGET" "$VERIFY_OUT" \
      || die "the node's own /health never reported $TARGET (got '$(grep -m1 '^health=' "$VERIFY_OUT" | cut -d= -f2-)'): the service is Running but the process is not serving the new build — check for a crash loop (see $VERIFY_OUT)"
    log "verify ok (service Running, .env=$TARGET, probe present, /health=$TARGET)"
    ;;
  *) die "unknown subcommand '$SUB'" ;;
esac
