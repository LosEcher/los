# Windows 进程沙箱调研（Node.js agent 编排系统适用）

- 日期：2026-08-17
- 背景：los 在 Windows 节点（普通用户、Win10/11 家用/专业版）需为"执行 shell/PowerShell 命令"加 OS 级沙箱；Linux 用 bubblewrap、macOS 用 sandbox-exec，Windows 无后端。
- 调研方式：web_search + 官方文档原文抓取 + npm/GitHub/PowerShell Gallery 核实。所有未查到证据的项明确标注。

---

## 1. Windows 官方沙箱机制盘点

### 1.1 AppContainer（含 IsolatedAppContainer / Win32 App Isolation）

| 维度 | 结论 |
|---|---|
| 原理 | 内核级进程隔离：低完整性级别（Low IL）+ AppContainer 身份 SID（S-1-15-2-…）+ 能力（capability）令牌；文件/注册表**虚拟化**（写入重定向到虚拟位置，不落真实路径）；凭证隔离（用户+应用联合身份，不能冒充用户）；网络默认**无出站**，需显式授权（internetClient 等）；进程/窗口隔离。AppContainer 原名 LowBox，可经 `CreateAppContainerProfile` / `NtCreateLowBoxToken` 创建 |
| 管理员/版本 | 创建 AppContainer 令牌**无需管理员**（间接证据：Chromium 在普通用户下运行的浏览器进程为其渲染进程创建 AppContainer token，Windows 10+ 生产使用多年）。任何 Win10/11 版本可用。**注意**：Win32 App Isolation（MS 新包装的 "IsolatedAppContainer" 打包模式）需要 **Win11 24H2+ + MSIX 打包 + 预览功能**，是另一回事 |
| 非特权进程调用 | 可以，但官方文档明言 unpackaged 应用需自己调 Win32 API，"it can be complicated" |
| 跑任意 exe（cmd/powershell） | 技术上可以（AppContainer 令牌 + CreateProcess）；**但任意路径读取困难**：用户目录等默认不可读，需逐路径授权 ACE；DSH 项目设计注记断言 "AppContainer cannot do arbitrary-path reads at all"。对"诊断命令要读系统/用户状态"场景是硬伤 |
| 文件系统 | 写虚拟化（不落盘）；读=仅被授权路径 + Everyone 可读对象 |
| 网络 | 默认无；能力白名单（出站可达）；loopback 需显式 |
| 性能 | 毫秒级（Chromium 生产验证） |

### 1.2 Windows Sandbox（WSB，VM 级）

| 维度 | 结论 |
|---|---|
| 原理 | 基于 Hyper-V 的轻量一次性 VM（独立内核），关闭即销毁，每次全新实例 |
| 版本 | **仅 Pro/Enterprise/Education**（官方明确：Windows Home 不支持）；需硬件虚拟化 |
| 管理员 | 功能启用需管理员（一次性）。多份官方 Q&A 报告标准用户启动会报 0x80070005 类权限错误 |
| 任意 exe | 完整 Windows 环境，可跑任何 exe（cmd/powershell 都行） |
| 文件系统/网络 | .wsb 配置文件可映射宿主目录（支持只读）、可关网络（默认开网，官方警告开网会暴露内网） |
| 程序化 | .wsb 文件 + PowerShell 模块 WindowsSandboxTools（Start-WindowsSandbox）；WinRT `Windows.Security.Isolation` / Win32 `isolatedwindowsenvironmentutils` API 可编程启动 |
| 性能 | 秒级启动、独立内存占用、**单实例限制**、交互式桌面 VM → 不适合高频命令级调用 |

### 1.3 Job Objects + Restricted Token

| 维度 | 结论 |
|---|---|
| 原理 | 复制调用者令牌 → `CreateRestrictedToken`（`WRITE_RESTRICTED` + restricting SID 列表）→ 用限制令牌 spawn + 装入 Job Object（`KILL_ON_JOB_CLOSE` 等资源/行为限制）。这是 Chromium Windows 沙箱四件套（restricted token + job object + 桌面 + 完整性级别）的核心 |
| 管理员 | **无需**。任何用户可创建 restricted token 与 job object |
| 任意 exe | 可跑任何 exe（cmd/powershell 均可） |
| 文件系统 | **只限制写**：Windows 仅在"调用者正常访问 AND restricting SID 交集"都允许时才放行写。**读不受限**（可读任意调用者可读文件）；Everyone/hard-link 边界导致"部分强制"（DSH 实测文档） |
| 网络 | 不受限（纯 token 机制管不了网络，需另配 WFP 或环境级控制） |
| 性能 | 近零（令牌复制级，微秒~毫秒） |
| 备注 | 这是 DSH `sandbox-windows-acl` 与 Codex `unelevated` 模式采用的机制 |

### 1.4 Windows Defender Application Guard（MDAG）

- **已弃用**：官方文档明确"MDAG（含 Windows Isolated App Launcher APIs）已弃用，Win11 24H2 起不再提供"。
- 原理：Hyper-V 容器隔离 Edge/Office 浏览会话。
- 版本：Win10 Enterprise 1709+/Pro 1803+/Education 1809+；Win11 Enterprise/Education/Pro（旧资料）。
- 管理员：功能安装需管理员；不支持 VM/VDI。
- **结论：不适合任何新方案。**

### 1.5 Win32 隔离 API（两个易混概念）

1. **Isolated Windows Environment（Windows.Security.Isolation / isolatedwindowsenvironmentutils）**：以编程方式把进程/应用跑进 Windows Sandbox VM —— 即 WSB 的程序化 API，底层仍要求 WSB（Pro + Hyper-V）。
2. **Win32 App Isolation（IsolatedWin32）**：让普通 Win32 应用以 AppContainer 身份运行的新特性，**预览中**，要求 Win11 24H2（build 26100）+ MSIX 打包 + 能力声明（isolatedWin32-* / UWP capabilities）。面向打包应用，不是为"任意命令行"设计的，且需开发者工具链。

---

## 2. 开源第三方方案

### 2.1 Sandboxie-Plus（最成熟）

- **原理**：内核驱动 SbieDrv（钩子）+ DLL 注入 + 令牌/作业对象；文件系统/注册表**虚拟化**（写重定向进"盒"，可恢复）；进程/窗口隔离。
- **许可**：GPL-3.0（GitHub stdexception/SandboxiePlus，~19k stars，2026-08-16 仍在推送，维护活跃）。Plus 有"supporter certificate"体系：免费档（eCertNoType）可用核心功能，付费证书（Patreon/个人/商业）解锁高级特性。
- **命令行/API**：`Start.exe` 可直接调起沙箱内进程：`Start.exe /box:TestBox /silent /wait /env:VAR=VAL -- cmd /c ...`，退出码透传；支持 `/terminate`、`/hide_window` 等。**Node 可用 `child_process.spawn` 直接调 Start.exe**（有社区文章演示 node 驱动）。
- **管理员要求**：安装驱动需管理员**一次**（每台机器）；之后普通进程可正常调起沙箱内进程。
- **能力**：可跑任意 exe；网络默认继承主机（可配限制）；写隔离强（虚拟化），读默认继承。
- **性能**：驱动+钩子，有少量固定开销。

### 2.2 wincage —— **未找到证据**

- 不存在名为 wincage 的 Windows 沙箱工具。SourceForge 的 "WinCaGe" 是富勒烯/纳米管结构生成**化学软件**（2016 年，与沙箱无关）。结论：**未找到证据**，大概率是名称混淆。

### 2.3 Firejail Windows 分支 —— **未找到证据**

- Firejail 依赖 Linux 命名空间特性，**仅限 Linux**，无官方 Windows 分支或移植计划（第三方站点只有 "Firejail Windows 替代品" 聚合页）。

### 2.4 NtObjectManager（类库/积木）

- 作者 James Forshaw（Google Project Zero），**Apache-2.0**，PowerShell Gallery 持续发布（1.0.x+）。
- 功能：NT 对象命名空间访问、`New-NtToken -Restricted` / 设置 restricting SID、Job Object、AppContainer 等全套 NT 原语 —— 是构造自定义沙箱的**乐高积木（研究/工具向）**，不是开箱即用"跑这条命令"的沙箱产品。

### 2.5 其他相关（新动向）

- **Microsoft MXC（@microsoft/mxc-sdk）**：微软官方早期预览的"代码执行容器"TS SDK（跨 Win/Linux/macOS）。Windows 默认后端 `processcontainer`（**Win11 24H2+**），另有 windows_sandbox / wslc / microvm / hyperlight / isolation_session 后端。**官方声明：当前 policies 过度宽松，"不构成安全边界"**；Windows 的 fs 策略暂不支持 deny 路径。→ 观察项，暂不可用。
- **zerobox-windows-sandbox**（Rust）：构建于 OpenAI Codex 沙箱运行时之上；macOS/Linux，**Windows "planned"（未提供）**。

---

## 3. Node.js 生态（现成库/命令行封装）

| 库/工具 | 类型 | 说明 |
|---|---|---|
| **`@deepseek-ai/dsh-sandbox-windows-acl`** | npm（BSD-3-Clause，0.0.1-rc.1 / next 0.1.0-rc.6，2026-08-10 发布） | **最贴合本场景的现成库**：restricted token（WRITE_RESTRICTED）+ 孤儿 SID 写白名单；Node/koffi 实现，无管理员要求；`AclSandbox.spawn({command, args})` 或 runner.js（argv 前缀包装，同 bwrap/landlock-run/sandbox-exec 架构）；只限写、不限读/网络；enforcement 自报 **partial**（Everyone/hard-link 边界）；0.x 阶段，DSH 仓库有 P0 bug 报告（discussion #758） |
| **`@anthropic-ai/sandbox-runtime`**（anthropic-experimental） | npm + 原生二进制 | **最强现成方案**：macOS Seatbelt / Linux bwrap+seccomp / **Windows x64（srt-win.exe：专用沙箱用户 + NTFS ACL + WFP 网络篱笆 + Job Objects）**；网络可 per-domain 白名单；含凭证掩码；**安装沙箱用户与 WFP 过滤器需一次性管理员**；arm64 Windows 未官方支持 |
| **`@microsoft/mxc-sdk`** | npm | 微软早期预览；Win11 24H2+；**明确不构成安全边界**，暂不推荐 |
| Sandboxie `Start.exe` | 命令行封装 | 非 npm，`child_process.spawn` 直接可调；需一次性驱动安装 |
| WindowsSandboxTools | PowerShell 模块 | WSB 封装（Start-WindowsSandbox）；依赖 Pro + Hyper-V |
| codex `windows-sandbox-rs` | Rust 二进制 | OpenAI Codex 的 Windows 沙箱实现（setup + command-runner）；非 npm，可借鉴实现 |

> npm 搜索补充：其余"沙箱"包（vm2、postman-sandbox、e2b、@vercel/sandbox、@utdk/isolate 等）均为 JS 层/云端沙箱，**不隔离 OS 级命令**，与本场景无关。

---

## 4. 现实建议（场景：不可信 agent 执行只读诊断 PowerShell + ping/curl 网络）

约束：普通用户、Win10/11 家用或专业版、优先免管理员/开发者模式、可脚本化、可接受性能开销。

### 方案 A（**首选**，零管理员、立即可用）：Restricted Token 写限制
- 用 `@deepseek-ai/dsh-sandbox-windows-acl`（或自研 koffi/nan 封装 CreateRestrictedToken，机制已开源）。
- 形态：`node runner.js --workspace <dir> --temp <dir> --mode read-only -- pwsh -NoProfile -Command ...`，或 `AclSandbox.spawn()`。
- **匹配度**：只读诊断命令 + 网络 ping/curl 恰好落在其能力圈内——写被限制在 workspace/私有 temp，系统与用户目录不可写；**网络不受限**（默认即可 ping/curl）。
- **优点**：零管理员/Pro/开发者模式/Hyper-V；进程级毫秒开销；完全脚本化（Node 直接 spawn）；read-only 与 workspace-write 两种模式。
- **缺点/边界**：只防"改"，不防"读/网络出站/进程可见性"——威胁模型若含"agent 读走用户机密"，本方案不够（可叠加环境变量脱敏与命令白名单缓解）；enforcement=partial（Everyone 与 hard-link 边界）；0.x 库需验收后再上生产。
- 与现有架构的契合：与 bwrap/sandbox-exec 同为"argv 前缀 runner"形态，los 沙箱接缝可直接复用同一套 confine() 契约。

### 方案 B（最强，需一次性管理员）：专用沙箱用户 + ACL + WFP
- 用 `@anthropic-ai/sandbox-runtime`（srt-win.exe）或参照 Codex `elevated` 实现（windows-sandbox-rs，Apache-2.0）。
- 形态：安装期（一次性 UAC）创建低权限沙箱用户 + WFP 出站篱笆 + NTFS ACL；运行期普通进程把命令放进沙箱用户执行。
- **能力**：写/读/网络三向隔离；网络可**按域名放行**（ping/curl 目标域名可白名单）；Job Object 保证 broker 退出即杀子进程。
- **代价**：一次性管理员 setup（企业策略可能禁止创建本地用户/防火墙规则）；家用/专业版均可，但要求那次提权。

### 方案 C（兜底/一次性高可疑负载）：Windows Sandbox 或 AppContainer
- **WSB**：Pro 版 + Hyper-V 前提；秒级冷启动、单实例、交互式桌面；.wsb 可只读映射工作区+关网络；适合"可疑 exe 试跑"，**不适合高频命令级调用**；程序化 API（Windows.Security.Isolation）需 WSB 已启用。
- **AppContainer（原始，非打包模式）**：零管理员可建 profile，但**任意路径读取困难**（诊断命令读系统/用户状态会被卡），网络需能力授权；工程复杂度高，不如 A/B。

### 结论
- 默认 **A**（零前置、秒接入、恰好覆盖"防改系统"+"可联网诊断"）；
- 威胁模型升级（防读/防出站）且部署方接受一次性提权 → **B**（Anthropic sandbox-runtime 或 Codex 同款实现）；
- **C（WSB）** 仅用于特殊一次性负载；AppContainer 不建议为本场景自研；
- **MDAG 已弃用，不选；Win32 App Isolation 预览中且面向打包应用，不选；MXC 明确非安全边界，观察。**

---

## 5. AI agent 在 Windows 上的沙箱策略现状

| 产品 | Windows 策略 |
|---|---|
| **Claude Code** | Bash 沙箱仅 macOS（Seatbelt）/ Linux、WSL2（bubblewrap + socat + 可选 seccomp）；**原生 Windows 不支持**，官方指引在 WSL2 内运行。注意：Anthropic 开源的 sandbox-runtime **库本身**有 Windows 后端（srt-win），但产品端未启用 |
| **Cursor** | 官方博客（2026-02-18）确认：macOS=sandbox-exec(Seatbelt)、Linux=Landlock+seccomp 自研组合；**Windows 上跑的是 WSL2 里的 Linux 沙箱**。原文："构建等价的原生 Windows 沙箱显著更难——现有沙箱原语都是为浏览器定制的，不支持通用开发者工具；正与微软合作推动必要原语" |
| **Codex（OpenAI）** | 三者中 Windows 做的最实：原生双模式 `windows.sandbox = "elevated" \| "unelevated"`。**elevated**=专用低权限沙箱用户+文件系统权限边界+防火墙规则+本地策略（需一次管理员批准的 setup，含离线用户防火墙规则）；**unelevated**=当前用户 restricted token + ACL 文件系统边界 + 环境级离线控制（无专用用户，较弱，企业策略禁止提权时回退）。由 `windows-sandbox-rs`（Rust，Apache-2.0，setup 与 command-runner 两二进制）实现；GitHub issue #18451 记录了 CreateRestrictedToken 失败(87) 的已知问题 |
| **Gemini CLI** | 见 PR google-gemini/gemini-cli#23936（forbiddenPaths 加入 GlobalSandboxOptions），以路径策略为主（旁证，未深查） |

**共同趋势**：Windows 原生沙箱在三大 agent 中要么没有（Claude/Cursor 走 WSL2），要么刚起步且分"一次性提权强模式/零提权弱模式"两档（Codex）——与第 4 节的 A/B 结论一致：**零管理员=受限令牌弱沙箱，强沙箱=必须一次提权**。

---

## 来源 URL 列表

### 官方文档
- AppContainer isolation (Win32)：https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- AppContainer for legacy apps：https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-
- Windows Sandbox overview（版本/许可/网络默认开）：https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-overview
- Windows Sandbox 示例配置：https://learn.microsoft.com/en-in/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-sample-configuration
- Windows 11 Security Book – Application Isolation（全机制总览）：https://learn.microsoft.com/zh-cn/windows/security/book/application-security-application-isolation
- Win32 app isolation overview（预览/24H2/MSIX）：https://learn.microsoft.com/en-us/windows/win32/secauthz/app-isolation-overview
- Win32 app isolation Supported Capabilities：https://learn.microsoft.com/en-us/windows/win32/secauthz/app-isolation-supported-capabilities
- IsolatedWindowsEnvironment Win32 API：https://learn.microsoft.com/en-us/windows/win32/api/isolatedwindowsenvironmentutils/
- Windows.Security.Isolation（UWP）：https://learn.microsoft.com/en-us/uwp/api/windows.security.isolation?view=winrt-22621
- MDAG 安装/要求（含弃用声明）：https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/microsoft-defender-application-guard/install-md-app-guard
- CreateAppContainerProfile：https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile
- Chromium Windows 沙箱设计（restricted token/job/desktop/integrity/AppContainer/LPAC）：https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/design/sandbox.md

### 第三方项目
- Sandboxie-Plus（GPL-3.0，活跃）：https://github.com/stdexception/SandboxiePlus
- Sandboxie Start Command Line（Start.exe 参数/退出码）：https://sandboxie-plus.com/sandboxie/startcommandline/
- Sandboxie 证书与支持者特性（免费档+付费）：https://deepwiki.com/sandboxie-plus/Sandboxie/6.6-certificate-and-supporter-features
- NtObjectManager（James Forshaw，Apache-2.0，PSGallery）：https://www.powershellgallery.com/packages/NtObjectManager
- Microsoft MXC：https://github.com/microsoft/mxc
- zerobox-windows-sandbox（Windows planned）：https://lib.rs/crates/zerobox-windows-sandbox

### Node 生态
- @deepseek-ai/dsh-sandbox-windows-acl（npm）：https://www.npmjs.com/package/@deepseek-ai/dsh-sandbox-windows-acl
- 同包 README（机制/边界/模式详解）：https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/sandbox/sandbox-windows-acl/README.md
- deepseek-harness sandbox 子系统文档：https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/subsystems/sandbox.md
- DSH Windows 沙箱 P0 bug 讨论（#758）：https://github.com/deepseek-ai/deepseek-harness/discussions/758
- Anthropic sandbox-runtime（npm，Windows srt-win 支持/需提权）：https://github.com/anthropic-experimental/sandbox-runtime
- sandbox-runtime Supported Platforms（Windows x64 Fully supported）：https://deepwiki.com/anthropic-experimental/sandbox-runtime/1.3-supported-platforms
- @microsoft/mxc-sdk（npm）：https://www.npmjs.com/package/@microsoft/mxc-sdk

### AI agent 现状
- Claude Code 沙箱化 Bash 工具（原生 Windows 不支持，WSL2）：https://code.claude.com/docs/en/sandboxing
- Cursor 沙箱博客（Win=WSL2、mac=Seatbelt、Linux=Landlock+seccomp）：https://cursor.com/blog/agent-sandboxing
- Codex Windows sandbox 文档（elevated/unelevated）：https://learn.chatgpt.com/docs/windows/windows-sandbox（镜像：https://github.com/mehmetbaykar/codex-docs-skill/blob/main/skills/codex-docs/references/windows__windows-sandbox.md）
- Codex windows-sandbox-rs 源码：https://github.com/openai/codex/tree/main/codex-rs/windows-sandbox-rs
- Codex issue #18451（CreateRestrictedToken 失败 87）：https://github.com/openai/codex/issues/18451
- Gemini CLI forbiddenPaths PR：https://github.com/google-gemini/gemini-cli/pull/23936

### 未找到证据项
- wincage 作为 Windows 沙箱：未找到（SourceForge "WinCaGe" 为富勒烯化学软件：https://sourceforge.net/projects/wincage/）
- Firejail Windows 分支：未找到（Firejail 仅 Linux）
