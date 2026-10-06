# los 执行面与任务路由

Date: 2026-10-06
前提：tools 转发已在主线恢复并实测 live（提交见 `main`）；8 台 executor 收敛到同一摘要。
用途：回答两个问题——**哪些场景/任务适合通过 los 执行**、**当前手上的开发任务哪些能交给 los**。

---

## 1. 先分清 los 的三种"执行"

| 层 | 名字 | 谁执行工具 | 触发方式 | 证据面 |
| --- | --- | --- | --- | --- |
| **E1** | 客户端工具调用（转发） | **调用方**（CanTool / Codex / 任意 SDK） | `POST /v1/chat/completions` 带 `tools` → 直转 provider，原样返回 provider body | 无 los 账本（los 只做网关）；上游错误经 `safeUpstreamMessage` 脱敏 |
| **E2** | los 自己的工具执行（agent loop） | **los**（在节点沙箱里跑 `run_shell`/读写/搜索等） | `POST /v1/chat/completions` **不带** `tools`；或 `los chat` | `task_runs` / `session_events` / tool call 记录 |
| **E3** | 受治理的执行（run contract） | los + 节点，**带验证** | Work Item → `run_specs`（plan 必须 `plan_approved`）→ `task_runs` → executor → `verification` record | 全套账本 + 可恢复 + 可审计；`canMarkSucceeded()` 没验证不许 succeeded |

**选择判据（一句话）**：
- 工具在调用方手里、只要"模型会调工具" → **E1**
- 只要求"这件事被执行了" → **E2**
- 要求"别人能复核这件事真的做成、且失败可恢复" → **E3**

今天 8 台节点 30 天的实际任务分布里，跑的几乎全是 **E2/E3 的分析与治理类**，**没有任何代码改造类**——这是后面判断"当前开发任务能否交给 los"的关键事实。

## 2. 通过 los 执行的硬前置（缺一条就会静默降级或直接失败）

| 前置 | 说明 | 现在的坑 |
| --- | --- | --- |
| provider ready + 额度 | 模型凭证、quota、健康路由 | 历史死信里 `Provider not configured` 18 条、403 usage limit 11 条 |
| 节点能力匹配 | `workspace_read/write`、`shell`、`sandbox`、`heavy_task_safe`、`deploy_safe` | `sandbox` 需求会把 `tool_policy` 节点（oracle/tencent-sin）**直接拒掉** |
| 沙箱形态 | macos-sandbox-exec / linux-bwrap / windows-acl | **不支持长驻交互**（stdin ≤64KB、无 REPL）；Windows 无 `bash` |
| 工作区边界 | `editableSurfaces` + 远程节点要 `workspaceRoot` 指向节点本地路径 | 路径写错会让写入落到空工作区 |
| 审批 | operator consent 5 类；scheduled_work 的 `approval_policy` | 审批超时清扫只处理 enabled schedule，retired 的僵尸 run 会永久挂着 |
| 预算与停止条件 | `maxLoops`、lease、`stopConditions` | confidence gate 会把"产物已落盘"的分析 run 记 failed |
| **不适合 los 的** | 浏览器自动化、GUI/桌面操作、需要实时人工介入的探索、长驻 REPL | 这些有专门的 DSH 技能/工具，硬塞进 los 只会得到更差的证据面 |

## 3. 后续可 los 执行的场景（按形态）

| 场景 | 层 | 触发 | 执行位置 | 前置 | 现状 |
| --- | --- | --- | --- | --- | --- |
| 定时治理巡检（job 异常/死信/待审批/todo） | E3 | `scheduled_work_items` cron | gateway-local | 无 | **已在跑**（每日 08:30） |
| 网络/surge 观测分析 | E3 | cron + interval | gateway-local | 桥接新鲜 | **已在跑**（本轮刚修好假新鲜） |
| feed/情报分析（lot2extension → los → 回调） | E3 | 外部 dispatch | gateway-local | 回调 SLO | **已在跑**（22 dispatches / 87 deliveries，死信 18 条） |
| 跨节点构建/回归 | E3 | 手工/定时 | `requiresBuild` → 只落 `heavy_task_safe` 节点 | lockfile 一致、构建产物路径 | 能力就位、**零使用** |
| 远程节点巡检/诊断（磁盘/服务/日志） | E2/E3 | interval | 目标节点（`run_shell`） | 节点在线 + 沙箱 | node34 漂移巡检在跑；其余节点零负载 |
| Windows 专用任务（需 Windows ACL/路径语义） | E3 | 手工 | desktop-r45553o / srsbe20 | 无 bash → 用 PowerShell 脚本 | 能力就位、**零使用** |
| 批量代码改造 + 回归验证 | E3 | Work Item | managed jj workspace（可指定节点） | run contract + `requiredChecks` | 能力就位、**零使用**（见 §4） |
| 文档/配置巡检与修复 | E3 | cron | 任意可写节点 | `editableSurfaces` 收敛到 docs/config | 能力就位、**零使用** |
| 数据搬运与校验（artifact / file-sync） | E2/E3 | 手工 | 源/目标节点 | `artifact_transfer`、`file_sync_deep_verify` | 能力就位、少量使用 |
| 外部 agent 的工具调用网关 | E1 | 客户端带 tools | 无（直转 provider） | provider 凭证 | **本轮恢复**（CanTool 是原设计目标） |
| 长跑集成/压测补位 | E3 | cron | 高资源节点（node34/m3pro/Windows） | 避免小内存节点 | 能力就位、**零使用** |
| 浏览器采集/后台操作（ZMS、后台盘点） | — | — | — | — | **不属于 los**：走 DSH 的 ego/kimi/terminal-browser 技能 |

## 4. 当前开发任务 → 能否通过 los 执行（逐条判定）

判定列含义：**✅可** = 现在就能用 los 执行且证据链完整；**🔶需前置** = 能，但先要补某样东西；**❌不适合** = 用 los 执行反而更差。

### 4.1 los 自身的缺口修复（上一轮 P0/P1）

| 任务 | 判定 | 执行方式与前置 |
| --- | --- | --- |
| P0-1 维护窗口接入候选过滤 | 🔶需前置 | 代码改动 + 测试：可用 E3（Work Item + run contract，`requiredChecks` 跑该包测试）。**但** los 目前没有"改代码"的作业模板，第一次要人工起一个 run spec |
| P0-2 verify 后自动 promote | 🔶需前置 | 同上；也可作为 `tools/deploy-to-remote.sh` 的小改动走 E3 |
| P0-3 promote 校验版本 | 🔶需前置 | 同上（`node-commands.ts` + 测试） |
| P0-4 内容校验（Linux/macOS 已有 build-version，Windows 用文件探针） | ✅可 | 已是脚本级动作；可挂成定时 E3 巡检（每 6h 比 `version` vs `build-version`） |
| P0-5 `resourceClass` 落库 | 🔶需前置 | 跨包改动（agent + executor），需要 compatibility gate |
| P0-6 `target_version` 比对出 todo | ✅可 | 纯读 + 出 todo：**最适合立刻变成一个 los 定时任务** |
| P0-7 sync 校验远端摘要 / upload-then-extract | 🔶需前置 | 脚本改动 + 8 台回归，属于"改代码"类 |
| P1-2 能力画像多维化 | 🔶需前置 | 改 `resource-metrics.ts` + 全节点回归 |
| P1-4 幂等键原语 | 🔶需前置 | 新表 + 迁移 + 接线，建议先只落在 feed-analysis 回调 |
| P1-5 工具三态审计 | 🔶需前置 | 与 tool-gate 合并 |
| P1-6 租约过期收敛路径 | ✅可 | 纯数据 + 治理 job 逻辑，适合 E3 |
| P1-7 变更端点补 operator 门禁 | 🔶需前置 | 代码改动 + 权限回归测试 |
| P1-8 22 个零引用契约接线或标注 | ✅可（部分） | 标注/文档类可；接线类需改代码 |
| P1-9 给 probe 加 TTL 与计划任务 | ✅可 | 定时 E3 任务（node_id 循环 + 出 todo） |
| P3 日报/巡检类增强（fleet 版本、桥接新鲜度） | ✅可 | **本轮已在 los 跑通**（`los-governance-daily.sh`），继续沿用 |

### 4.2 环境里的其它真实任务

| 任务 | 判定 | 说明 |
| --- | --- | --- |
| WIP 分支剩余内容（grok 入网/节点恢复记录 + `grok-start-los-executor.sh`） | ❌不需要 | 纯历史记录与一次性脚本，人工归档即可 |
| 把 DSH 的 11 个 scheduler job 中绕开 los API 的两个改成走 los（治理日报改脚本→API；verify-los/cantool 定时验证改成 `scheduled_work_items`） | ✅可 | **最高价值的一步**：`job-440be80b` 目前 `lastStatus=failed`，改成 los 的 run contract 后自带 verification record 与失败可恢复 |
| dsfolder 工具链接线（verify-gate / run-diff / golden-tasks 变成"变更→回归→门禁"流水线） | ✅可 | 这三件产物已在盘上；在 los 里就是 `requiredChecks` + `editableSurfaces` + managed workspace，天然契合 E3 |
| 8 台待命节点的场景分派（Windows 专用、构建主机、低资源巡检、网络出口） | ✅可 | 先给每台登记角色，再用 E3 的 `executor`/`workspaceRoot` 指定落点；这一步同时解掉"6 台零负载" |
| cantool 跨机构建与验收 | 🔶需前置 | 构建本身可走 E3（落在 m3pro/Windows）；但 cantool 的"用户可见行为验证"要在 M1 真机跑，属 DSH 技能（`verify-cantool`） |
| ZMS / 后台盘点类任务 | ❌不适合 | 需要浏览器与登录态，属 ego-browser 技能 |
| 微信/飞书等 IM 交互 | ❌不适合 | los 侧渠道全停；走 DSH 渠道 |
| 本机磁盘/进程审计、冷层数据搬运 | ❌不适合（los 视角） | 有专门技能与工具链；los 只在需要"证据"时才介入 |

### 4.3 为什么"代码改造类"目前是 🔶 而不是 ✅

三个具体障碍，都有证据：
1. **没有在跑的范式**：30 天 1022 个 task_run 里没有代码改造类任务，全是治理/分析/巡检；`docs/adr/0038` 想做的"日常编码 agent"路径尚未被使用。
2. **缺作业模板**：`scheduled_work_items` 现有 7 个模板都是 `runtime_readiness` / `scheduled_execution` / `fleet_host_check` / `daily_execution_digest`，没有"改代码 + 跑测试 + 出 diff"的模板。
3. **验证面虽在、但没接**：`managed-workspaces` + `verification` + `run-diff`/`verify-gate` 三件套都已存在（后者在 dsfolder），缺的是"一个真实改动走完整条链"的首例。

**建议的首例**（低风险、可验证）：拿 P0-6（`target_version` 比对出 todo）或 P1-6（租约过期收敛）这类**纯读+治理**的改动作为第一个 E3 作业；再拿 P0-3（promote 校验版本）作为第一个"改代码+测试"的 E3 作业，`requiredChecks` 就用 `packages/agent` 的该文件测试 + `tsc --noEmit`。

## 5. 三条立即可做的动作（按性价比）

1. **把 `job-440be80b`（verify-los/cantool 定时验证，现 failed）迁成 los `scheduled_work_items`**：立刻得到 verification record、失败可恢复、并填上一个"los 执行 los 验证"的真实用例。
2. **新增一个 6h 的 fleet 一致性 E3 任务**：比对 8 台 `/health.version` 与本地 `build-version` 及 `target_version`，不一致出 todo（数据已具备：本轮已写入统一 `target_version`）。
3. **给"改代码"起一个作业模板**（`editableSurfaces` = 目标文件、`requiredChecks` = 该包测试 + tsc、`toolMode` = project-write、`sandboxMode` = workspace-write），用它跑 P0-3 作为首例，成功后把模板固化成 `docs/governance/` 下的一条可复用作业。


---

## 6. 实测：los 定时执行能做什么、不能做什么（2026-10-06 首例验证）

为了让"执行用 los"从建议变成事实，用 `tools/los-fleet-consistency.sh`（确定性只读巡检）做了首个端到端验证。四轮尝试把边界钉死了：

| 尝试 | 模板配置 | 结果 | 原因 |
| --- | --- | --- | --- |
| 1 | `toolMode=all` + `sandboxMode=workspace-write` | ❌ 失败 | `tool denials: run_shell×1 (Tool risk L2 exceeds max L1)` —— L1 不允许 shell |
| 2 | `toolMode=all` + `sandboxMode=sandbox` | ⚠️ 有 shell 但结果不可用 | run_shell 通过，但 OS 沙箱**阻断 TCP**且 `/dev/null` 不可写 → 脚本的 `psql`/`curl` 全废（`checked=0`，exit 3） |
| 3 | `toolMode=all` + 不设 `sandboxMode` | ❌ 失败 | 设计上该分支应退回"L2 无强制沙箱"，但 scheduled-work 层实测仍强制 L1 |
| 4 | **`toolMode=project-write` + 文件判读** | ✅ **succeeded** | 5 轮 / 16 秒 / 57k prompt tokens；报告落在 `reportDir`，台账 `reportPath` 正确 |

**风险阶梯（`packages/agent/src/loop/tool-resolver.ts:60-121`）**：

```
sandboxMode=readonly              → maxRiskLevel L0（无写、无 shell）
sandboxMode=workspace-write
  或 toolMode=project-write       → maxRiskLevel L1（**run_shell 被拒**）
sandboxMode=sandbox               → maxRiskLevel L2 + 真实 OS 沙箱（shell 可用，但沙箱内无网络）
toolMode=all（无 sandboxMode）    → 设计上 L2 无沙箱；定时执行路径实测到不了
```

**推论（这就是 los 执行面的真实边界）**：
1. **los 的定时执行被设计成"工作区内的文件作业"**，不是"任意脚本执行器"。沙箱存在的意义正是让 agent 的写操作可限制、可复核。
2. 因此任何**需要网络或数据库**的确定性检查，必须是"**沙箱外采集 → 沙箱内判读**"两段式；这正是 network-observe 桥接已经在用的模式，本轮把它确认为**通用形态**。
3. 采集段天然属于 **DSH/launchd 侧（管理面）**，判读段属于 **los（执行面）** —— 与"DSH 主管理、los 按需执行"的分工完全一致。

**已验证形态 A（推荐，已跑通）**：
```text
[DSH/launchd] bash tools/los-fleet-consistency.sh --snapshot   # 采集：需要网络+DB，落在工作区文件
                     ↓  .los-runtime/fleet/fleet-versions.json
[los] scheduled_work_item (project-write, 6h)                  # 判读：只读文件 + 写报告 + 出 verification
                     ↓  .los-runtime/fleet-reports/<ts>-fleet-consistency.md
[DSH/看板] 读报告与 todo                                        # 管理：看结论、决定是否 rollout
```

**首例工件**：`schedule-fleet-consistency-001`「fleet consistency check (6h)」，`toolMode=project-write`、`reportDir=.los-runtime/fleet-reports`、`requiredChecks=['read_file .los-runtime/fleet/fleet-versions.json']`；判据是「进程版本 == 账本版本 == 该节点声明的 target_version」，并显式排除"网关工作树比集群目标新"这种 rollout 期的正常差异（第一版脚本就栽在这个误报上）。

**尚未接的一环**：快照生产者目前是手工跑一次；要让它真正循环，需把 `--snapshot` 挂到 DSH 调度或 launchd（每 6h），并给判读任务加"快照过期即 input_stale"的门（与 network/surge 两个分析任务的 STALENESS GATE 同构）。这一步是纯配置，不需要改 los 代码。


---

## 7. 采集端挂载：两个沙箱夹出来的结论（2026-10-06 实施记录）

把 §6 的两段式真正接起来时，又撞出一个必须记下来的事实：**采集端既不能在 los 沙箱里跑，也不能在 DSH 沙箱里跑。**

| 尝试 | 结果 | 证据 |
| --- | --- | --- |
| 采集端放 **los 定时任务** | ❌ | §6 四轮：L1 不给 shell；给 shell（`sandboxMode=sandbox`）则沙箱阻断 TCP → `curl`/`psql` 全废 |
| 采集端放 **DSH scheduler**（job-87c60739-d01，工作区 `~/.dsh/scheduler-reports`） | ❌ 且**假成功** | headless agent 跑脚本时，重定向写 `.los-runtime/fleet/…` 被拒（EPERM，目标在它工作区之外），而 run 仍记 `succeeded`；快照 mtime 根本没变（已删除该 job） |
| 采集端放 **launchd**（`com.echerlos.los.fleet-snapshot`，6h，`RunAtLoad`） | ✅ | `runs=1`，快照 mtime 从 21:54:16 → 21:58:42，写入的是仓库真实路径 |

**结论：需要网络+DB 的"采集"必须在两个沙箱之外，即 launchd（或 CI/外部 runner）。** 这与 network-observe 桥接当年的结论完全一致——不是巧合，而是同一类约束。

**闭环形态（已跑通）**：
```text
launchd  com.echerlos.los.fleet-snapshot      每 6h  →  .los-runtime/fleet/fleet-versions.json
los      schedule-fleet-consistency-001       每 6h  →  读快照判读 → 报告 + 台账（带 STALENESS GATE）
DSH/看板 读报告与 todo                                   →  人工决定是否 rollout
```
判读端已二次复验：`succeeded`，报告时间戳与最新快照一致（`2026-10-06T13-58-42Z`）。

**对 §5 第 1 条建议的修正**：`job-440be80b`（每周一 07:30 的验证资产维护）**不该迁到 los**。它的 `lastStatus=failed` 与 `exit=0` 并存，真实原因是
`delivery missing for key "job-440be80b-ecc|2026-10-04T23:30:00.000Z"（在 ~/.dsh/storages/feishu-push 找不到 .sent）`
—— 即**推送投递记账缺失**，属 DSH 管理面问题，迁到 los 既修不了它、也会把"能访问真机的验证"搬进一个没有网络的沙箱。正确处置：修 DSH 的投递记账（管理面 follow-up），验证本身留在 DSH/真机侧。

**下一步（第 3 步，尚未开跑）**：第一个"改代码"类 E3 作业。按 §6 的阶梯，它能走的路只有前半段：
- ✅ 可以做：在 `editableSurfaces` 内产出改动（L1 允许文件写入），并让 los 写出改动说明与自检结论；
- ❌ 做不了：在 los 里跑测试（L1 无 shell；`sandboxMode=sandbox` 有 shell 但无网络，`pnpm`/依赖解析与 `/dev/null` 都成问题）。
- 因此形态应是：**los 出改动 + 证据 → 外部 runner（DSH/CI）应用并跑测试 → 结果回写 los 的 verification**。这与"DSH 管理 / los 执行"一致：los 负责受治理的改动产出与账本，测试执行属于外部 runner。
