# Windows 节点恢复与驱动加固（desktop-srsbe20 回到新版）

Date: 2026-10-11

Subject: `tools/deploy-drivers/windows-service.sh`、`tools/los-fleet-rollout.sh` 的 windows 分支、
`desktop-srsbe20` / `desktop-r45553o` 两台 Windows 执行器。

一句话：**srsbe20 不是"缺 pnpm/corepack"，是它的非交互 SSH 会话 PATH 里没有 Node**；
而 Windows 的 `verify` 此前只断言"服务 Running + `.env` 已盖章 + 探针文件在"，
这三条对一个**在 nssm 下崩溃循环、不再心跳**的进程全部成立 —— 于是死节点被记成
"已安全回退到旧版"。补齐 install 步骤与第四条断言后，机队 **8/8** 全在目标版本。

## 1. 现场（改动前的真实状态）

| 判据 | srsbe20 当时的观测 |
| --- | --- |
| 注册表 | `offline`，版本 `0.1.0+b47a933663dc7`（**旧**） |
| 磁盘 `.env` | `LOS_VERSION=0.1.0+bf48c196bd57b`（**新**） |
| 服务 | `sc query los-executor` → `STATE 4 RUNNING` |
| 进程 | Services 会话里有一个 `node.exe` |
| workspace 链接 | `packages\agent\node_modules\@los\` = contracts, infra, redaction —— **没有 mcp-stdio** |
| 执行器日志 | `C:\los\.los-runtime\executor.log` 不存在 |

`.env` 是新版本、注册表是旧版本、服务 Running 却不心跳 —— 这就是 runbook 里
"stamp alone does not prove which code is on disk" 那条警告的现场，也是旧 `verify` 无法
分辨的状态。根因是目标修订让 `packages/agent` 新 import `@los/mcp-stdio`，而 workspace 链接
归 pnpm 管、`tar` 不搬 `node_modules`。

## 2. 纠错：srsbe20 并不缺 pnpm

上一轮的结论是"该机没有 pnpm/corepack，无法为新 workspace 包建链接"。**这条是错的**：

```text
dir C:\Users\los\AppData\Roaming\npm
→ codex.cmd … pnpm  pnpm.cmd  pnpm.ps1  pnpx.cmd …     # pnpm 装着
where node / Get-Command npm                            # 非交互会话里找不到
```

`C:\Program Files\nodejs` 与 `%APPDATA%\npm` **不在该机的机器 PATH 里**，非交互 SSH 会话
因此看不见 node/npm/pnpm（同一台机器上 `C:\Program Files\nodejs\node.exe` 确实存在，
且执行器服务本身在跑）。⇒ 判据必须是"能不能真的调起来"，不是"`where` 找不找得到"。

顺带修掉第二个同类假象：`Get-Command pnpm` 会优先命中 `pnpm.ps1`，而非交互会话的默认执行策略
拒绝运行脚本 —— 表现是"pnpm 明明装着却什么都跑不了"。驱动改为解析 **`.cmd` 垫片**再调用。

## 3. Windows 驱动改了四处

| 改动 | 原来的问题 |
| --- | --- |
| 新增 `install` 子命令，编排器在 activate 前调用 | 新增/删除 workspace 包的发布必然把节点打成崩溃循环 |
| `sync` 的成功判据从 `grep -E "^(extracted\|stamped\|probe=)"` 改为**逐个标记**断言 | 命中**任意一行**就算成功：解包成功但盖章没跑到会被判成功，留下"`.env` 新、代码旧" |
| `verify` 补第四条断言：节点自己的 `/health` 版本 == 目标 | 前三条对崩溃循环全过 ⇒ 死节点被记成"已安全回退到旧版" |
| 脚本改为**上传后 `-File` 执行**；`.ps1` 带 UTF-8 BOM；参数用双引号；输出 `LC_ALL=C tr -d '\r'` | 见下节四条 PowerShell-over-SSH 陷阱 |

（驱动还顺手把 plan 输出的 `digest=<no-response>` 改注为 `n/a (no bash)`、
把 "NO DRIVER — manual" 改成实际动作 —— Windows 上跑不了 `bash tools/los.sh build-version`，
那是**探针不可用**，不是"节点没响应"。）

## 4. PowerShell-over-SSH 的四条陷阱（都实测踩过）

1. **`powershell -Command -` 逐行执行 stdin**：跨行的块（`if/for/try`）在块首之后被静默丢弃，
   不报错也不继续（一个跨行 `foreach` 只打印了块前那一行）。原驱动只用无块单行语句，所以没暴露。
2. **`-EncodedCommand` 会撞 cmd.exe 的 8191 字符上限**：脚本一带中文注释就超限，远端只回
   "命令行太长"（base64 + UTF-16LE 让体积再翻一倍多）。⇒ 改为 scp 上传 + `-File`。
3. **`.ps1` 必须有 UTF-8 BOM**：Windows PowerShell 5.1 无 BOM 时按系统 ANSI（本机 GBK）解码，
   中文注释被解成乱码并吃掉后面的引号/大括号 —— 唯一带中文注释的 `install.ps1` 报
   `}` 是意外标记，而同为纯 ASCII 的 sync/verify 正常。
4. **`cmd.exe` 不认单引号**：用单引号包参数会把引号原样传进 `param()`，
   `"$WinHome\.env"` 于是被 PowerShell 当成"C: 驱动器上的相对路径"（`DriveNotFoundException`）。
   另外 PowerShell 输出 CRLF，锚定断言前必须 `LC_ALL=C tr -d '\r'`
   （`LC_ALL=C` 是必须的：CLIXML 错误文本是本地代码页，UTF-8 locale 下的 `tr` 直接
   `Illegal byte sequence`）。

## 5. 验收证据

| 判据 | 结果 |
| --- | --- |
| srsbe20 滚动 | `install ok (…pnpm.cmd, frozen-lockfile)`（`Packages: +1`）→ `verify ok (svc=Running, stamped=target, probe present, /health=target)` → **converged** |
| 机队 | `online=8 on_target=8`；`--plan` 中两台 Windows 也报 `registry=0.1.0+bf48c196bd57b status=online` |
| win-los 回归 | sync / install / verify 三步在新机制下全部通过（没有为了修 srsbe20 弄坏健康节点） |
| **负向控制（新的 /health 断言）** | 把 srsbe20 `.env` 的 `EXECUTOR_PORT` 临时改成 8099（**进程不动，仍在 8090 服务**）：`svc=Running` ✓、`stamped=target` ✓、`probe=True` ✓、`health=unreachable` ⇒ **前三条全过、第四条拦下**，报 `the service is Running but the process is not serving the new build` |
| 负向控制的可回滚性 | 恢复 `EXECUTOR_PORT=8090` 后 `verify` 立即通过；机队仍 `online=8 on_target=8` |
| 失败的可见性 | 修好之前，srsbe20 的滚动以 `FATAL: pnpm install did not succeed` **拒绝继续**（而不是把半死节点标成 online）——fail-loud 生效 |

## 6. 证据边界与残留

- **Windows 仍没有内容摘要**：`verify` 现在断言 `/health`（进程面）与探针文件（内容面的一瞥），
  但没有逐文件 digest，所以 Windows 节点永远不满足协调器的 `digest == target` 跳过条件，
  **每轮滚动都会重跑驱动**（保守但安全）。补它需要把 `tools/los.sh` 的文件清单导出成单一真源，
  再在 PowerShell 里重算，而不是写第二份清单。`[E]`
- **`desktop-r45553o` 的 `pnpm` 与仓库 `packageManager` 不完全同版**（机器上是 11.7.0，
  仓库 pin 11.6.0，`pnpm install` 自身按 lockfile 走）。install 已按 `packageManager` 装上
  pin 版本作为缺失时的兜底，但**没有**主动把已有 pnpm 降到 pin 版本（那会改动健康节点）。`[E]`
- `install` 走的是 `pnpm install --frozen-lockfile`，网络抖动会拉长耗时
  （srsbe20 本轮 ~2 分钟，含一次 registry 重试），失败即非零退出、不会静默降级。`[E]`
