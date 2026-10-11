import { _buildBwrapArgs } from '../tools/external/shell-sandbox.js';
import { loadExecutorNode, type ExecutorNodeRecord } from '../executor-nodes.js';
import { normalizeOptionalString, readObject } from './helpers.js';

/**
 * placement-probe-command — **按平台生成放置探测命令**（S8，2026-10-11 晚从 `placement.ts` 拆出）。
 *
 * 拆出来的理由有两层：
 * ① 机械门禁：`placement.ts` 因这段涨到 575 行，超过仓内 500 行硬限（`tools/check-structure.sh`）；
 * ② 职责：这里只回答"**在某个平台上，怎么把'这个工作区在不在'问出来**"，
 *    而 `placement.ts` 回答"**在候选之间怎么选**"——两件事的变更理由不同。
 *
 * ⚠️ 判据不变：**换语言，不降标准**。两个平台分支的输出协议逐字相同
 * （`PRESENT[ <rev>]` / `ABSENT`），因此解析器与 `reachable` 口径不受影响。
 */

/**
 * 只读探测命令：**一条**，同时回答 存在/不存在、revision，以及**声明的沙箱到底能不能跑**。
 *
 * 为什么不用 `test -d` + 单独取 revision：两次往返 = 两倍的瞬时失败面，而这里每一次探测
 * 都在派发路径上。
 *
 * ⚠️ 2026-10-11 实测（本模块第一次上线就被自己的证据面抓到）：这里少写一个 `;`，
 * 整条命令在**所有**节点上都以 `Syntax error: "then" unexpected` 立刻失败，
 * 而当时的 `reachable` 只看"有没有退出码" ⇒ 每个节点都被当成"已核实"。
 * 现在有两条防线：① 本函数由单测用 `sh -n` 做**语法**校验；② `reachable` 要求
 * **退出码 0 且输出可解析**。教训：判据必须能区分"跑通了"与"跑过了"。
 *
 * ⚠️⚠️ 同一天的第二个实例（vultr）：节点上报 `capabilities.sandbox = linux-bwrap`（二进制在），
 * 但因为宿主策略，**以服务用户身份**跑 bwrap 会 `bwrap: loopback: Failed RTM_NEWADDR:
 * Operation not permitted` —— 声明的能力**实际不可用**，任务跑到一半才炸（agent 侧
 * `run_shell` 全失败，最后由 self-check 兜住并 blocked）。
 * ⇒ 探测必须**在任务的真实上下文里演练那条沙箱**，而不是只问"有没有这个二进制"。
 * 现在：节点上有 bwrap 就**通过 bwrap 跑探测**，bwrap 起不来就回 `SANDBOX_FAILED rc=… <stderr>`，
 * 于是"沙箱跑不动"在**派发之前**就变成不可核实，而不是运行中的失败。
 *
 * ## ⚠️⚠️⚠️ 第三个实例：分平台（S8，2026-10-11 晚）
 *
 * 上面这条"对不支持 POSIX 的节点会失败，那是正确的"，**在 Windows 上是错的**：
 * 它把"节点没有 POSIX shell"与"节点不能执行任务"混成一件事，于是**永久**挡住 Windows
 * （FLEET 文档 §6 自曝的限制）。两台 Windows 实测：
 *
 * | 节点 | 同一份 POSIX 探测的报错 | 真因 |
 * |---|---|---|
 * | desktop-srsbe20 | `spawn C:\Windows\system32\cmd.exe ENOENT` | **cwd `/tmp` 不存在**（不是 cmd 不存在）；已在 `node-command-runner.ts` 里把 `/tmp` 规范化并在错误里带上 cwd |
 * | desktop-r45553o | `'d' 不是内部或外部命令`（GBK） | `shell:true` = **cmd.exe 读不懂 POSIX** |
 *
 * 正确修法是**按平台分派**（与参考实现"沙箱按 OS 各一套"一致），而**不是**放宽
 * `reachable`：`win32` 分支换成 PowerShell，**输出协议逐字不变**（`PRESENT[ <rev>]` /
 * `ABSENT` / 失败自报），因此 `parseProbeOutput` 与 `reachable` 口径**一行都不用改**。
 * 判据是"节点答了什么"，不是"命令长什么样"——**换语言，不降标准**。
 */
export function _buildWorkspaceProbeCommand(
  workspaceRoot: string,
  options: { bwrapPath?: string; platform?: string } = {},
): string {
  const targetPlatform = options.platform ?? process.platform;
  const quoted = shQuote(workspaceRoot);
  const inner = [
    `d=${quoted};`,
    `if [ -d "$d" ]; then printf PRESENT;`,
    `r=$(git -C "$d" rev-parse --short HEAD 2>/dev/null);`,
    `[ -n "$r" ] && printf ' %s' "$r";`,
    `else printf ABSENT; fi;`,
    `true`,
  ].join(' ');
  if (targetPlatform === 'win32') return _buildWindowsWorkspaceProbeCommand(workspaceRoot);
  const bwrapPath = options.bwrapPath ?? '/usr/bin/bwrap';
  // 与 agent 真正执行 shell 时**同一套**参数（单一来源：_buildBwrapArgs），避免"探测用的沙箱"
  // 与"任务用的沙箱"漂移——那正是这个探测要防的事。
  // ⚠️ `_buildBwrapArgs` 只返回 **argv**；可执行文件由调用方拼（真实现见 shell-sandbox.ts 的
  // `runWithLinuxBwrap`）。漏掉这个前缀会让探测以 `--ro-bind` 当命令名执行，于是**每个有 bwrap
  // 的节点都假红**（单测里那条"假 bwrap"用例就是抓这个的）。
  const wrapped = [
    shQuote(bwrapPath),
    ..._buildBwrapArgs(bwrapPath, workspaceRoot, inner, 'readonly', 'isolated').map(shQuote),
  ].join(' ');
  return [
    `if [ -x ${shQuote(bwrapPath)} ]; then`,
    `out=$(${wrapped} 2>&1); rc=$?;`,
    `if [ "$rc" -eq 0 ]; then printf '%s' "$out";`,
    `else printf 'SANDBOX_FAILED rc=%s %s' "$rc" "$out"; fi;`,
    `else ${inner}; fi`,
  ].join(' ');
}

/**
 * Windows 分支：**一条 PowerShell 语句**，输出协议与 POSIX 分支逐字相同。
 *
 * 设计约束（每一条都对应一个实测过的坑）：
 * - 只用 PowerShell 5.1 就有的语法（`if(){}else{}`、`Test-Path`、`Write-Output`）；
 *   **不用** `??`（PS 7+ 才有）——节点上是 5.1（实测 `PWSH=False`）；
 * - `2>$null` 压掉 git 的 stderr、`$ErrorActionPreference='SilentlyContinue'` 压掉
 *   NativeCommandError，避免"git 不存在"把整条探测变成非零退出；
 * - 结尾 `exit 0`：**探测的失败是数据，不是崩溃**（POSIX 分支末尾的 `true` 同理）；
 * - revision 是**可选字段**：srsbe20 上根本没有 git，`present` 仍然必须成立
 *   （否则又是"用一个可选证据否定整个节点"）；
 * - 路径里的 `'` 按 PowerShell 规则翻倍转义（与 POSIX 的 `'\''` 是同一件事）。
 *
 * Windows 没有 bwrap/seatbelt 这一支：agent 侧的 Windows 沙箱是 `windows-acl`
 * （`shell-sandbox-windows.ts` 自己 spawn `powershell.exe`），所以这里**不演练 Linux 沙箱**，
 * 只回答"存在性 + revision"。沙箱有效性由 agent 侧真实执行时 fail-closed 暴露。
 */
export function _buildWindowsWorkspaceProbeCommand(workspaceRoot: string): string {
  const literal = `'${workspaceRoot.replace(/\\/g, '/').replace(/'/g, "''")}'`;
  return [
    `$ErrorActionPreference='SilentlyContinue';`,
    `$d=${literal};`,
    `if (Test-Path -LiteralPath $d -PathType Container) {`,
    `Write-Output -NoEnumerate 'PRESENT';`,
    `$g=Get-Command git -ErrorAction SilentlyContinue;`,
    `if ($g) { $r=(& git -C $d rev-parse --short HEAD 2>$null | Select-Object -First 1);`,
    `if ($r) { Write-Output -NoEnumerate (' ' + $r.ToString().Trim()) } }`,
    `} else { Write-Output -NoEnumerate 'ABSENT' };`,
    `exit 0`,
  ].join(' ');
}


/**
 * 从候选记录里取平台（`capacity.platform`：`darwin`/`linux`/`win32`）；取不到返回 undefined。
 *
 * 放在本模块而不是 `placement.ts`：平台决定的是"生成哪种命令"，
 * 而"目标节点的平台不能拿网关自己的 `process.platform` 代替"这条正是本模块的职责边界。
 */
export function _nodePlatform(node: ExecutorNodeRecord | undefined): string | undefined {
  const platform = readObject(node?.capacity).platform;
  return normalizeOptionalString(platform);
}

/** POSIX 单引号转义（`'` → `'\''`）。Windows 分支**不用**它：那边的引号规则是"翻倍"。 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
