# RunSeal 符合度评估与沙箱项目调研（2026-08-17）

> 背景需求：los 的 shell 沙箱目前只有 macOS sandbox-exec / Linux bubblewrap 两个后端，
> Windows 节点（desktop-r45553o，Win10 Pro build 26200，用户 los 属管理员组，Hyper-V 关闭）
> 无 OS 沙箱后端 → L2 工具（run_shell 等）全部被拒，两条 Win sing-box 诊断调度无法恢复。
> 本轮调研：RunSeal 是否符合需求 + 可用的沙箱项目全景。
> 关联代码：`packages/agent/src/tools/external/shell-sandbox.ts`（后端选型/执行）、
> `packages/executor/src/executor-heartbeat.ts`（`detectSandboxBackend` → 心跳上报 capabilities.sandbox）、
> `packages/agent/src/scheduler/executor-client.ts`（`satisfiesCapability`：sandbox 值须为真实后端才解锁 sandboxMode=sandbox）。

## 一、RunSeal 是什么（与"官网"的命名警示）

- 定位：**OS-native、策略治理的本地命令执行边界**，专为 agent 框架设计（Rust 实现）。
  提供稳定执行协议（CLI / JSON-RPC stdio / MCP / service 模式）把命令放进
  文件系统/进程/资源/网络边界内执行，输出 JSONL audit 事件。
- ⚠️ 命名：`runseal.io` 是另一家运维公司，**与本项目无关**。本项目官方站是
  https://runseal-labs.github.io/runseal/ ，仓库 https://github.com/runseal-labs/runseal ，
  设计契约在 https://github.com/runseal-labs/rfcs 。
- 不是：AI 治理平台 / 云 VM / Docker 替代 / microVM。是 local-first 执行边界（可复用已装工具链与企业网络配置）。

## 二、技术机制与平台（源码级核实）

| 平台 | 后端 | 机制 | 状态 |
|---|---|---|---|
| **Windows** | **第一等参考后端** | vendor 自 OpenAI Codex `codex-rs/windows-sandbox-rs`：**AppContainer/LowBox + 受限令牌 + WFP 防火墙 + ACL deny-read**；一次 UAC setup（`runseal setup windows-sandbox --elevate`） | supported；要求 **Win10 1809 / build 17763+**；非 Hyper-V 方案 |
| macOS | 实验 | `/usr/bin/sandbox-exec` + 生成 seatbelt profile（deny-by-default + 只读基线 + 策略读写根） | experimental |
| Linux | 实验 | **本质就是 bubblewrap**（`--unshare-user/pid/ipc/uts`，非 unmanaged 时 `--unshare-net`；workspace-write = 全盘只读根 + 工作区 rw + tmpfs /run,/tmp）。Landlock 只探测、**不参与强制** | experimental |

- 拦截粒度：策略维度（文件系统读写根 / 进程 / 网络模式+路由 / 环境 scrub / 资源 / 审计）× OS 原生机制，**不是 seccomp 级 syscall 过滤**。
- 特权：Windows 仅 setup 一次 UAC；运行无需常驻特权。Linux/macOS 无需 root。
- 沙箱档位：`danger-full-access` / `read-only` / `workspace-write` / `workspace-contained`（更严格）。
- 网络三态：`unmanaged`（直通，= los host 档）/ `disabled`（全拒，= los isolated 档）/ `proxy`（受控外发：隔离 netns + execution-local relay + **per-execution token 认证** + 路由白名单 + 凭据脱敏 + audit）。
- 已知限制：stdin 非交互流（bytes/file，默认 ≤64KB），**不支持长驻交互命令（REPL）**。

## 三、集成方式（对 los 最关键）

- CLI：`runseal exec --json --events --policy workspace-write --network disabled --cwd <ws> --timeout-ms 30000 -- cmd args` —— 与 los 现有 `execFile(sandbox-exec/bwrap, ...)` 的 spawn 形态**完全同构**。
- JSON-RPC stdio：`runseal rpc --stdio`，方法含 `execute / getExecution / listExecutions / cancelExecution / subscribeEvents / getAuditEvents / getSetupStatus` 等；service 模式可常驻持有执行状态。
- MCP server：`runseal mcp --stdio`（模型可传 command/cwd/timeout/env，**不可改 policy/network**）。
- **现成 Node 参考**：同组织插件 [dsh-tool-runseal](https://github.com/runseal-labs/dsh-tool-runseal)（MIT）＝薄 Node wrapper：spawn `runseal rpc --stdio` → 一次 execute → 转发 stdout/stderr → 透传退出码，注册为 DSH 的 `ctx.sandbox`。**los 接入姿势可直接照抄。**
- 分发：GitHub Releases 预编译二进制（linux/macOS/windows × x86_64/arm64，0.7–2.3MB）+ SHA256SUMS + SBOM + sigstore 签名。

## 四、成熟度与风险

| 维度 | 事实 |
|---|---|
| Star/贡献者 | **0 star / 1 人**（ferstar，430 commits；创建 2026-06-14，日更级活跃） |
| 版本/许可 | v0.1.x（最新 v0.1.11），**Apache-2.0** |
| 官方状态 | **technical preview**（非生产承诺）；Windows=reference，macOS/Linux=experimental |
| 质量基建 | RFC 流程（20 篇）、黑盒 conformance 测试、adversarial harness（RFC-0016）、fail-closed 契约、SBOM+签名发布 —— 工程严谨度远高于一般 0-star 项目 |
| 风险 | 生态/采用度为零、**单点维护**、pre-1.0（CLI/JSON/审计形状可能破坏性变更）、Linux/macOS 后端实验期 |

## 五、可选沙箱项目矩阵（含 Windows 与 Linux）

### Windows 侧

| 方案 | 管理员 | 能力 | 契合度与说明 |
|---|---|---|---|
| **A. RunSeal**（windows-runseal 后端） | 一次性 UAC setup | 三档沙箱 + 网络三态 + audit + RPC 集成 | **首选试点**：语义与 los sandboxMode/sandboxNetwork 一一映射；dsh-tool-runseal 可作 wrapper 模板 |
| **B. @deepseek-ai/dsh-sandbox-windows-acl**（restricted token） | **零管理员** | 只限**写**（WRITE_RESTRICTED+孤儿 SID 白名单），读/网络不受限 | runner 形态与 bwrap/sandbox-exec 同构（argv 前缀），**恰好匹配"只读诊断+ping/curl"**；enforcement=partial（Everyone/hard-link 边界）；0.x 库 |
| **C. @anthropic-ai/sandbox-runtime**（srt-win.exe） | 一次性提权 | 专用沙箱用户 + NTFS ACL + WFP 网络篱笆 + Job Object，网络可按**域名白名单** | 威胁模型升级（防读/防出站）时的最强现成选项 |
| **D. Sandboxie-Plus**（Start.exe） | 一次性驱动 | 写虚拟化、网络继承 | 备选（GPL-3.0、内核驱动） |
| **E. Windows Sandbox（WSB）** | Pro + Hyper-V + 管理员 | VM 级 | 高频命令调用不适用；本机 Hyper-V 已关 → 不选 |
| **F. AppContainer 自研** | 零 | 强但**任意路径读取困难** | 诊断命令需读系统/用户状态 → 不选 |
| ~~G. MDAG~~ | — | 已弃用（Win11 24H2 起移除） | 不选 |
| ~~H. Win32 App Isolation~~ | — | 预览中、MSIX 打包限定 | 不选 |

### Linux 侧（对照）

- **维持 bwrap 为主沙箱**：与 Claude Code（bwrap+socat 网络代理+可选 seccomp）、Codex CLI（bwrap+helper）、ai-jail 等 2026 行业主流一致；无 root、近零开销、Flatpak 大规模生产背书。
- **Rust 重写（P3 受约束执行世界）按计划加 Landlock 内层**：worker 子进程 fork 后 exec 前 `restrict_self`（landlock-rs，best-effort ABI 降级）做内核级路径/端口强制，bwrap 之上第二道屏障——与 Codex、nono、arapuca 已验证形态同构。
- **网络放行不要押 Landlock**：Landlock 网络仅 TCP bind/connect（ABI4+），2026-06 LKML 确认 TCP Fast Open 可绕过；可靠做法＝bwrap host 网络 + 进程内代理白名单（Claude Code socat 先例）。seccomp 仅作可选第三层（拦 ptrace 等）。
- 不建议引入：Firejail（setuid、LPE CVE 史）、gVisor/微 VM（40–150ms+ 开销）、nsjail（root/配置重）、proot（非安全边界）、Wasm（不能跑任意原生二进制）、systemd-run（依赖 systemd）。
- **RunSeal 对 Linux 无增益**（其 Linux 后端本质就是 bwrap，Landlock 未强制），勿作为 Linux 后端替换。

## 六、结论：RunSeal 是否符合需求

**高度符合（作为 Windows 后端）**：它精确补上 los 缺失的平台——Windows 一等后端（Codex windows-sandbox 同源机制），
沙箱档位与网络模式与 los 现有语义一一映射，CLI/RPC 集成形态与 `shell-sandbox.ts` 的 spawn 模式同构，
且有现成 DSH Node wrapper 参考实现；本机落地条件已实测满足（Win10 Pro build 26200 ≥ 17763、
los 在管理员组且 SSH 会话已提权可免二次 UAC、Hyper-V 关闭不影响）。

**不符合的部分**：作为 Linux 后端升级（无新原语）、作为生产依赖（technical preview / 0 star / 单点维护、
pre-1.0 破坏性变更风险）。

## 七、对 los 的接入建议（分步）

1. **短期试点（解 Win 燃眉之急）**：desktop-r45553o 部署 RunSeal 三件套（runseal.exe / setup / command-runner）
   → `runseal setup windows-sandbox --elevate`（一次）→ los 新增 `windows-runseal` 后端：
   - `shell-sandbox.ts`：`SandboxDecision` 加 `'windows-runseal'`；win32 且探测到 runseal.exe 时走
     `runseal exec --json --policy <映射> --network <映射> --cwd <ws> --timeout-ms <t> -- <cmd>`；
     映射：sandboxMode readonly→`read-only`、workspace-write→`workspace-write`、sandbox→`workspace-contained`（严格）或 `workspace-write`；
     networkMode isolated→`disabled`、host→`unmanaged`；其余保持 native-denied fail-closed。
   - `executor-heartbeat.ts` `detectSandboxBackend`：win32 探测 runseal → 上报 `sandbox:'windows-runseal'`
     （复用现有闸门，`satisfiesCapability` 自动放行）→ Win 节点解锁 `sandboxMode='sandbox'`（L2 shell）。
   - 恢复两条 Win sing-box 诊断调度（模板补 `sandboxMode:'sandbox'` + `workspaceRoot:'C:\Users\los\los'`）验证。
   - 冒烟：探针 run 断言 run_shell L2 approved + 网络档生效；runseal 缺失/未 setup 时报明确错误且拒绝（fail-closed）。
2. **零提权替代/兜底**：若不愿在 Win 节点做一次性提权，`@deepseek-ai/dsh-sandbox-windows-acl`（restricted-token 写限制，
   零管理员）可作 workspace-write 级兜底——但只防"改"不防"读/出站"。
3. **中期风险对冲**：若 RunSeal 生态未成长，直接 vendor OpenAI `windows-sandbox-rs`（Apache-2.0，elevated/unelevated 双模式）
   ——RunSeal 的 Windows 后端本来就是它。
4. **Linux/macOS 不动**：bwrap / sandbox-exec 保持；Rust 重写 P3 按计划加 Landlock 内层；网络放行维持
   "bwrap host + 代理白名单"模式。
5. **接口稳定性**：接入时锁定协议版本（runseal.protocol/v1），把 RunSeal 封装在 `shell-sandbox.ts` 后端适配层内，
   隔离 CLI 变更；写 conformance 冒烟测试（sandbox 档位矩阵 × 网络模式 × fail-closed）。

## 来源

- RunSeal 文档站：https://runseal-labs.github.io/runseal/ ｜ 仓库：https://github.com/runseal-labs/runseal ｜ RFC：https://github.com/runseal-labs/rfcs（0001/0003/0009/0018/0020）
- dsh-tool-runseal（Node wrapper 参考）：https://github.com/runseal-labs/dsh-tool-runseal
- OpenAI Codex windows-sandbox-rs：https://github.com/openai/codex/tree/main/codex-rs/windows-sandbox-rs
- @deepseek-ai/dsh-sandbox-windows-acl：https://www.npmjs.com/package/@deepseek-ai/dsh-sandbox-windows-acl
- @anthropic-ai/sandbox-runtime（srt-win）：https://github.com/anthropic-experimental/sandbox-runtime
- Sandboxie-Plus：https://github.com/stdexception/SandboxiePlus
- Claude Code 沙箱（bwrap+socat）：https://code.claude.com/docs/en/sandboxing ｜ Cursor 沙箱博客：https://cursor.com/blog/agent-sandboxing
- Landlock 内核文档：https://docs.kernel.org/userspace-api/landlock.html ｜ TFO 绕过（2026-06 LKML）：https://lkml.iu.edu/hypermail/linux/kernel/2606.2/03202.html
- 关联调研文件：`docs/research/2026-08-17-windows-sandbox-research.md`（Windows 方案明细）

## 八、试点结果（2026-08-17 实机验证，desktop-r45553o）

### ① RunSeal —— 已部署，被上游 Windows 后端阻塞（未启用）
- 已部署三件套（runseal.exe / runseal-windows-sandbox-setup.exe / runseal-command-runner.exe → C:\los\runseal，用户 PATH 已加），`setup windows-sandbox --elevate` 成功（`requires_setup:false`，沙箱用户 `RunSealSandbox` 已建，helper 已物化到 `%LOCALAPPDATA%\RunSeal\windows-sandbox\.sandbox-bin`）。
- **阻塞证据**：`runseal exec`（CLI 与 `rpc --stdio` 双路径）全部 `EXECUTION_FAILED_TO_START`；沙箱日志显示子进程 `whoami.exe` 以 `exit code -1073741502 (0xC0000142 STATUS_DLL_INIT_FAILED)` 失败，elevated broker（runseal-windows-sandbox-setup）持续挂死（高 CPU、锁日志/输出文件），`timed out after 15000ms connecting runner pipe-in`。SSH 会话与计划任务交互会话均复现。属上游已知问题类别（openai/codex#14057 PowerShell DLL fail、#10352 ACL 问题），非本机配置可解。
- los 侧 `windows-runseal` 后端已接线（shell-sandbox.ts 分支 + runSealPolicyName/NetworkName 映射 + 单测），gated 于 `agent.windowsSandboxBackend='runseal'`（默认关闭）。待上游修复后置 `runseal` 即可启用。

### ② 零提权 restricted-token —— npm 包被工具链阻塞，原生 C# 草案待验证
- `@deepseek-ai/dsh-sandbox-windows-acl`（koffi 绑定）已接入 package.json 并接线（`windows-acl` 后端，lazy import，单测通过）；**但 koffi 无预编译二进制、必须 CMake+编译器源码构建**，Win 节点无该工具链 → 运行不可用（`Cannot find the native Koffi module`）。
- 原生替代草案：`tools/windows-sandbox/los-windows-sandbox.cs`（零提权 WRITE_RESTRICTED + 能力 SID 写白名单 + Job Object，csc 内置于 .NET Framework 免工具链）。**状态=DRAFT，未部署**：WRITE_RESTRICTED 交会语义需在真实节点做验证电池（workspace 可写 / 系统目录禁写 / 输出捕获 / 退出码）后才可上线。

### ③ 文档 PR —— 待推送

## 2026-08-17 晚更新：验证B闭环（限制SID机制被环境级阻断）

spawn-probe 隔离矩阵（14 种限制身份 × flags、桌面授权、TMP 覆盖）证明：本机任何带限制 SID 的
token 都无法孵化子进程（0xC0000022/0xC0000142），未限制的 duplicate token 正常（exit 0）。
system32/cmd.exe 无 Everyone ACE 解释了 {World,capSid} 读 DLL 失败；schtasks /rl highest 仍为
deny-only Administrators（无提权），net user /add 失败（无专用沙箱用户）。RunSeal 同机制失败
交叉印证。**决策：Win run_shell 保持 paused（fail-closed），网络探针改走固定 hash-pinned 只读
PS 快照脚本 + Job Object 的受监督执行；RunSeal 本节点放弃；C# 沙箱保留为交互式桌面参考实现。**
详见 2026-08-17-windows-sandbox-research.md「验证B」节。

## 2026-08-17 深夜更新：hash-pinned 只读探针 runner 已落地并双节点验证

实现（los 仓库，change szummzxv「feat(agent): hash-pinned read-only node probe
runner (run_node_probe)」）：
- tools/node-probes/los-probe-net.ps1（Win）/ los-probe-net.sh（Linux）：只读网络
  探针（TCP/ping/HTTP + 本地服务进程），单条 JSON 输出，零磁盘写。
- tools/windows-sandbox/los-probe-runner.cs → los-probe-runner.exe（Win 监督器）：
  SHA-256 pin 校验（嵌入式 DefaultPins + 可选 --pins json 覆盖）+ kill-on-close
  Job Object + 超时 + 输出捕获；未 pin/篡改一律拒绝（exit 3，fail-closed）。
- tools/node-probes/los-probe-run.sh（Linux 监督器，同语义，sha256sum 校验）。
- los 工具 run_node_probe（registry，shell toolset + READ_ONLY_BUILTIN_TOOLS，
  L1/只读/免审批），Win→exe、Linux→sh；LOS_PROBE_DIR 可覆盖探针目录。

验证（两端四步全过）：①pin 正确→运行并返回探针 JSON（Win 1.1.1.1:443 超时
/8.8.8.8:53 与网关 OK/sing-box+vivaldi 在跑；node34 同样 1.1.1.1:443 失败）
②未 pin 脚本→拒绝 ③同路径篡改→hash mismatch 拒绝（报 expected/actual）
④还原→恢复运行。部署：Win C:\los\bin\probe\（pin 内嵌 8feb80b3…）；
node34 /opt/los/bin/probe/（pins.sha256 0626894f…）。
