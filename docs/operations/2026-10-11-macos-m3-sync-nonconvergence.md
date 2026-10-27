# M3（macOS）内容同步不收敛：根因与恢复

Date: 2026-10-11

Subject: `m3pro-executor-1`（ssh 别名 `m3-t`，`~/.local/share/los`，launchd
`com.echerlos.los-executor`）连续三次滚动"同步中断"，根因定位、修复与恢复证据。

一句话：**不是传输路径问题，也不存在半同步的树。** 剪枝步骤用了 GNU 专有的
`xargs -a FILE -d '\n'`，macOS 的 BSD xargs 两个选项都不认，于是**恰好一个**被上游重命名
删除的源文件留在了节点上；内容摘要覆盖每个源文件，所以远端 digest 永远不等于机队目标。
去掉那个文件，远端 digest 立刻等于目标。

## 1. 原始现象（滚动留下的证据）

| 时点 | 目标摘要 | 远端 digest | 脚本结论 |
| --- | --- | --- | --- |
| 14:33（`LOS_DEPLOY_SYNC_MODE=pipe`） | `0.1.0+b1843b8ff669e` | `0.1.0+b75d5062198b6` | `sync aborted mid-way (exit 1)` |
| 14:40（默认 upload） | `0.1.0+bf48c196bd57b` | `0.1.0+b580057c47487` | 同上 + `do NOT restart it` |
| 14:50 | `0.1.0+bf48c196bd57b` | （同上） | sync 日志 **0 字节** |

当时的推断是"半同步 / 疑似别名 scp 传输路径"。两条推断都不对：

- "每次 digest 都不同"是**目标在动**（14:33 与 14:40 的 target 本身不同），不是树在变；
- "日志为空"是因为**成功时 `scp`/`tar xzf` 本来就不输出**，而剪枝那一步的输出没有被
  重定向进日志——文件里唯一那条 `export LANG=C >> "$log_file" 2>&1` 只重定向了
  `export` 内建命令，属于写错位置的旧代码。

## 2. 根因链

1. 上游 `refactor(mcp-stdio): extract a leaf stdio MCP client for memory` 删除了
   `packages/agent/src/tools/external/mcp-stdio-transport.ts`（由新包 `@los/mcp-stdio` 取代）。
2. `sync` 的剪枝步骤**正确识别**了它：M3 上 `/tmp/los-stale.list` 只含这一行，
   时间戳 14:50（即"诊断到"了，但"删不掉"）。
3. 删除用的是 `xargs -a /tmp/los-stale.list -d '\n' rm -f --`。实测 M3：
   ```text
   xargs: invalid option -- a
   usage: xargs [-0opt] [-E eofstr] [-I replstr [-R replacements] [-S replsize]]
   xargs_exit=1
   ```
4. `remote_sh bash -s … <<'PRUNE_STALE'`（内含 `set -euo pipefail`）因此非零退出，
   本地 `set -e` 立刻中止 sync——`.env` 从未盖章（所以注册表一直停在 `0.1.0+b47a933663dc7`），
   而 `SYNC_EXTRACTED=1` 已经置位，收敛守卫于是打印"aborted mid-way / may be half-synced"。
5. 摘要按 `find … | sort | xargs shasum -a 256 | shasum -a 256` 计算，**覆盖每一个源文件**，
   多一个文件就永远不等。⇒ 三次滚动三次失败，且每次都把 M3"安全地"退回旧版。

## 3. 决定性复现（可重放）

逐文件比对（两侧同一份 `find` + `xargs shasum -a 256`）：

```text
本机 1455 行、M3 1456 行；hash 不同的文件 0 个；M3 多出 1 个：
packages/agent/src/tools/external/mcp-stdio-transport.ts
```

⇒ **"半同步"不成立：内容只多不少。**

```text
# 把它移到备份位（可回滚）后，M3 自查：
$ ssh m3-t 'cd ~/.local/share/los && bash tools/los.sh build-version'
0.1.0+bf48c196bd57b          # == 机队目标

# 反向复现：把它放回原位
0.1.0+b580057c47487          # == 14:40 滚动报告里的那个值，逐位一致
```

## 4. 顺带发现的两个缺陷

### 4.1 macOS 分支没有 install

M3 的 `packages/agent/node_modules/@los/` 只有 `contracts/infra/redaction`，
**没有 `mcp-stdio`**——而目标修订里 `packages/agent/src/tools/external/mcp-client.ts`
正面 import `@los/mcp-stdio`。也就是说：即使剪枝修好了，重启仍会
`ERR_MODULE_NOT_FOUND` 崩溃循环（与 Windows 驱动缺 install 是同一个失效模式）。

判别身份时踩到一个 macOS 陷阱：**`id -u los` 在 M3 上返回 0**（目录服务把不存在的名字
解析成了当前用户，uid 501），而 `dscl . -list /Users` 里并没有 `los`；用"名字存在性"做判据
会选错分支。改成**按能力**判别（`su - los -c true`）后，M3 立刻 `su: Sorry`、Linux 节点成功。

### 4.2 每次 sync 都会把 `.env` 的 600 打回 644

版本盖章用 `awk … > .env.tmp && mv .env.tmp .env`（为了绕开 BSD sed 的 `-i ''`）。
`mv` 替换后文件的权限位来自**新文件**（umask 派生），于是：
**手工把 `.env` 收到 600，跑一次 sync 就回到 644**（实测复现）。

这条是"复查"顺带查出来的：runbook 当时统一要求 600，而工具每次滚动都在静默撤销它。
修法是先记住原权限、盖完恢复——刻意**不硬编码 600**，因为 Linux 节点的
`/opt/los/.env` 是 `root:root 644`，服务用户 `los` 要靠它读文件；强行收紧会让执行器起不来。

## 5. 修复（都在发布器里）

| 文件 | 改动 |
| --- | --- |
| `tools/deploy-to-remote.sh` | 剪枝删除改为可移植的 `while IFS= read -r` 循环；删完**复核**，删不掉就 `prune: FAILED` + 非零退出；剪枝输出统一进 sync 日志、摘要回显到 stdout；收敛守卫的消息改为按日志区分"陈旧文件没剪掉"与"文件真的缺失" |
| `tools/deploy-to-remote.sh` | `do_install` 用 `remote_pnpm_sh`：能 `su - los` 才 su，否则以登录用户直跑（macOS） |
| `tools/deploy-to-remote.sh` | 盖章前记住 `.env` 权限、盖完恢复（不再把 600 静默改成 644） |
| `tools/deploy-to-remote.sh` | sync 只在**真的有 systemd** 的节点上同步 unit 文件：原判据是"仓库里有这个文件"（每台都成立），于是 macOS 每次 sync 都以一条 `could not copy systemd unit` 假警告结束——同一类"误导性输出"，一并清掉 |
| `tools/los-fleet-rollout.sh` | macOS 分支补 `install`；新增 `wait_health_version`：重启后必须等到 `/health.version == target`（原先只 promote + 看注册表 status，一个"重启失败但服务还活着"的节点能混过去） |

## 6. 验收证据

**M3 终态** `[E]`（2026-10-11 15:38 之后）

| 判据 | 值 |
| --- | --- |
| 内容摘要（节点自查） | `0.1.0+bf48c196bd57b` == 目标 |
| `/health` | `status=ok`、`version=0.1.0+bf48c196bd57b`、`versionSource=env`、`activeTaskCount=0` |
| 注册表 | `online`、`version=target`、`target_version=target` |
| 进程 | launchd `running`，`runs` 10 → 11，新 pid `54866` 起于 15:38:11（新码真在跑） |
| 依赖 | `packages/agent/node_modules/@los/mcp-stdio -> ../../../mcp-stdio`；install 日志 `Packages: +1` |
| `.env` | 由 `0644` 收到 `0600`，收紧后 `/health` 仍 ok；修复后 sync 不再把它打回 644（见下表） |
| 协调器复核 | `--plan` 报 `m3pro-executor-1: already converged (digest+registry+online) — skip` |

**功能验收（不只是"版本戳对了"）** `[E]`

M3 之所以必须更新，正是为了拿到这一批新能力；升级前对它下 `run-check` 只能得到旧码的
`{"error":"command is required"}`。修复后：

```text
POST /nodes/m3pro-executor-1/commands  {"command":"run-check","args":{"command":"uname -s; hostname; sw_vers -productVersion", …}}
→ status=succeeded exitCode=0 stdout='Darwin\nlosdeMacBook-Pro.local\n26.6.2'
```

`Darwin` + 该机主机名 + 系统版本 ⇒ 检查**在 M3 本地真的执行了**（不是网关代跑）。
至此三平台指纹齐了：`node34` = `Linux\nz-Standard-PC-Q35-ICH9-2009`、
`desktop-r45553o` = `DESKTOP-R45553O`、`m3pro-executor-1` = `Darwin\nlosdeMacBook-Pro.local\n26.6.2`。

**修复的定向验证**

| 场景 | 结果 |
| --- | --- |
| 把真实陈旧文件放回 M3 → 跑修好的 sync | `prune: 1 stale file(s) …` → 删除 → `digest verified: 0.1.0+bf48c196bd57b`，exit 0 |
| **负向控制（macOS）**：`chflags uchg` 造一个删不掉的陈旧文件 | `prune: FAILED — could not remove stale path`、`sync aborted after extraction`、exit 1；不再假成功 |
| **对照组（Linux，node34）**：植入一个陈旧文件 | `prune: removed 1 stale file(s)`，digest 不变，exit 0 ⇒ 新旧两种 userland 都覆盖 |
| `.env` 权限保持 | M3 收紧到 600 后再跑 sync → 仍 `600`；node34 原 `root:root 644` → 仍 `644`，`systemctl is-active` = `active`（修复前 M3 会回到 644） |
| macOS 复跑 sync | 不再出现 `could not copy systemd unit` 假警告；Linux 复跑 sync 后 `/etc/systemd/system/los-executor.service` 时间戳按本次滚动更新、服务仍 `active` |

负向控制还揪出我自己的一个 bug：收敛守卫由 `EXIT` trap 调用，看不到 `do_sync` 的
`local log_file`，诊断信息以 `log_file: unbound variable` 半路夭折（已改为全局
`SYNC_LOG_FILE`）。**如果不做负向控制，这条只会在下一次真实故障时才暴露。**

## 7. 证据边界与残留

- 本文的"14:33 那次也是同一个根因"属 `[I]`：当时没有留存逐文件清单，只能由
  "目标在动 + 复现值逐位一致"支持；已定位并复现的是 14:40/14:50 那次。`[I]`
- 传输路径本身**未发现缺陷**：`scp` + 双侧 `sha256` + 节点本地解包在 M3 上每次都成功。`[E]`
- 机队其余节点未受影响的地基检查：Linux 侧剪枝此前一直在跑（GNU xargs 支持那两个选项），
  所以这个缺陷**只在 macOS 节点发作**——这正是它藏了这么久的原因。`[E]`
- 未做：`tools/deploy-drivers/macos-launchd` 驱动文件（macOS 仍是编排器内的内联分支）；
  Windows 驱动的 install 步骤；`.env` 权限的**机队一致性检查**（现在 sync 不会再改它，
  但也没有任何门禁在核对它，fleet 上 600 与 root:root 644 两种形态并存）。
