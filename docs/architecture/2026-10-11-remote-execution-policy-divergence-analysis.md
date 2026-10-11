---
subject: 调度/远端执行路径的"声明策略 ≠ 生效策略"缺陷（los 网关 + agent）
auditedRev: 1d5d0a9a (git, 本轮工作副本基线)
readOnly: true
method:
  - 真机探针（scheduled_execution 远端 smoke，落点 node34-executor-1）
  - 真库 SQL（scheduled_work_items / scheduled_work_item_runs / task_runs / verification_records / session_events）
  - 源码阅读（scheduled-work-routes / scheduled-work/policy / scheduled-task-runner / executor-client / tool-resolver）
---

# 远端执行的策略偏差：诊断与改动意见（2026-10-11）

## 1. 症状（三条实测，同一次 smoke run）

我创建并触发了一个 `scheduled_execution`，声明 **`toolMode=read-only` + `sandboxMode=sandbox`**，目标是 `node34-executor-1`：

| 观测 | 声明 | 实际 |
| --- | --- | --- |
| `scheduled_work_items.run_template_json` | `toolMode: read-only` | **`toolMode: "project-write"`**（静默改写） |
| 远端会话 `session.started.toolPolicy` | 期望 L2 + 沙箱 | **`{maxRiskLevel: "L1", allowWrites: true, sandboxAvailable: false}`** |
| 声明的 `requiredChecks: [uname -s, hostname]` | 应执行并留证 | **0 条 `verification_records`**（该 run 连 `run_spec_id` 都为空） |

## 2. 因果链（每一环都有落点）

1. **静默改写 toolMode** — `file:packages/gateway/src/routes/orchestration/scheduled-work-routes.ts:324`
   ```ts
   function normalizeToolMode(value: unknown): 'all' | 'project-write' {
     return value === 'all' ? 'all' : 'project-write';   // read-only 也走这里
   }
   ```
   该文件**自己定义**了这个函数（没有导入 `chat-normalizers` 的共享版），创建（`:222`）与更新（`:267`）都用它。
   同文件的姊妹函数 `normalizeSandboxMode`（`:327`）**是 fail-loud 的**——说明作者的意图是"拒绝非法值"，只有 toolMode 这一处退化成"静默兜底"。
2. **因此策略校验反而通过** — `file:packages/agent/src/scheduled-work/policy.ts:79`
   ```ts
   if (runTemplate.toolMode !== 'project-write' && runTemplate.toolMode !== 'all')
     throw new Error('scheduled_execution requires project-write (or all with sandboxMode=sandbox) tool mode');
   ```
   这条 fail-loud 对 `read-only` **永远不可达**：值在进入校验前已被改写。
3. **sandboxMode 在 project-write 下是死配置** — `file:packages/agent/src/loop/tool-resolver.ts:68-90`（短路点在 `:78`）
   分支顺序是 `readonly` → **`workspace-write || toolMode==='project-write'`** → `sandbox`；
   于是 `toolMode=project-write` 时**永远命中第二个分支**（L1 / `sandboxAvailable:false`），
   而 `file:packages/agent/src/scheduled-work/policy.ts:92-96` 又**强制要求**远端执行必须给 `sandboxMode`。⇒ **"必须设置、但设了不生效"**。
   （对照：本地 chat 路径 `sandboxMode=sandbox` + 非 project-write 时确实得到 L2 + `sandboxAvailable:true`，见 §10 的执行策略实测表。）
4. **门禁随之静默失效** — `requiredChecks` 是 shell 命令，而 L1 拒绝 L2 工具（`run_shell`）⇒ 检查根本没跑；
   加上调度路径的 run **没有 `run_spec_id`**，`verification_records` 也就没有记录 ⇒ **从"检查失败"退化成"没有检查"**（静默）。

## 3. 三个缺陷（按影响排序）

| ID | 缺陷 | 性质 | 影响 |
| --- | --- | --- | --- |
| **D1** | `scheduled_execution` 把 `read-only` 请求**静默提升为 `project-write`** | 权限提升（安全相关） | 调用方以为只读，实际拿到可写权限；审计上"声明"与"事实"不一致 |
| **D2** | `sandboxMode='sandbox'` + `toolMode='project-write'` 组合被接受但 sandboxMode **无效** | 死配置 / 声明≠生效 | 远端执行**没有沙箱**（`sandboxAvailable:false`），而校验却宣称必须给 sandboxMode |
| **D3** | 调度路径的 `requiredChecks` 既不执行也不留证，且**没有任何错误** | 门禁静默失效 | 跨设备任务的"完成"缺少机械证据；门禁看起来存在、实际不存在 |

共同根因（与本会话反复出现的失效模式同型）：**"声明面"比"消费面"宽**——契约/校验接受了一个下游不会兑现的组合，且没有任何一处 fail-loud。

## 4. 改动意见

### D1（建议立即改，最小面）
- **改法**：删掉路由私有的 `normalizeToolMode`（`:324`），改用 `chat-normalizers.ts:27` 的共享版；
  让 `read-only` 原样进入 `validateScheduledExecutionRunTemplate`，由它按既有措辞**拒绝**并说明原因
  （"scheduled_execution requires project-write (or all with sandboxMode=sandbox)"）。
- **验收**：`POST /scheduled-work-items` 带 `toolMode=read-only` ⇒ **400 + 明确原因**（而不是 201 且存成 project-write）；
  负向控制：`toolMode=all` + `sandboxMode=sandbox` 仍可创建；`project-write` 仍可创建；
  既有 scheduled-work 测试与 policy 测试保持通过。
- **风险**：低。会让"以前静默通过"的调用方开始报错——这正是想要的；如担心既有 item，可对**已存**的 item 不追溯（只在创建/更新时拦）。

### D2（建议同批改，二选一，推荐 A）
- **A（推荐，改校验）**：`policy.ts` 增加配对规则——`sandboxMode === 'sandbox'` 时**必须** `toolMode === 'all'`，
  否则拒绝（与既有错误措辞完全一致："or all with sandboxMode=sandbox"）。
  这样"必须给 sandboxMode"就不再是空话：给了就必须配 `all`，而 `all` 会让 sandbox 分支真正命中。
- **B（改 resolver）**：把 `sandbox` 分支提到 `project-write` 之前，让沙箱模式优先。
  影响面更大（会改变 chat 路径 `project-write + sandbox` 的既有语义），需另行评估。
- **验收**（A）：`project-write + sandboxMode='sandbox'` ⇒ 400；`all + sandboxMode='sandbox'` ⇒ 201 且**实际会话** `toolPolicy.maxRiskLevel='L2'`、`sandboxAvailable=true`（远端节点需有 bwrap：node34 能力显示 `linux-bwrap`）。

### D3（建议分两步）
- **步 1（观测）**：调度路径把声明的检查写进 `verification_records`（该表**已有** `task_run_id` 与 `skip_reason` 列 ⇒ 机制齐全，只是没接）；
  跑不了时写 `status='skipped'` + `skip_reason='policy_denies_run_shell(L1)'`，让"没检查"可见。
- **步 2（门禁）**：创建时就拒绝不可能执行的组合（声明了 shell 类检查但生效策略 < L2），
  或明确要求跨设备任务使用 `toolMode='all' + sandboxMode='sandbox'`。
- **验收**：`verification_records` 里出现该 `task_run_id` 的记录（成功或带原因的 skipped）；跨设备任务的"完成"能被机械核对。

### D4（可选，观测面）
- `POST /scheduled-work-items` 的响应回显**生效策略**（由模板推导的 toolMode/sandboxMode/maxRiskLevel），
  让"你请求什么 / 你将得到什么"在创建时就可见，而不是等 `session.started` 才知道。

## 5. 实施记录（D1 + D2(A) 已修，真机验证，2026-10-11）

**改动**
- **D1**：`scheduled-work-routes.ts` 删掉文件私有的 `normalizeToolMode`，改用 `chat-normalizers.ts` 的共享版
  ⇒ `read-only` 原样进入 `validateScheduledExecutionRunTemplate`，由它 fail-loud 拒绝。
- **D2(A)**：`policy.ts` 新增配对规则——`sandboxMode === 'sandbox'` 时必须 `toolMode === 'all'`，
  否则拒绝（错误文案与既有的 "or all with sandboxMode=sandbox" 对齐）。

**波及面实测（改前先查）**：现有 17 条 scheduled item 里 `scheduled_execution` 只有 `project-write`×7 与 `all`×6；
5 条 `read-only` 全部属于**非 execution 模板**（`runtime_readiness`/`fleet_host_check`/`daily_execution_digest`/`scheduled_feed_analysis`）
⇒ **零回归面**（唯一命中新规则的是我上一步 retired 的 smoke 条目）。

**真机验收（网关重启后）** `[E]`

| 请求 | 结果 |
| --- | --- |
| `toolMode=read-only` | **400** `scheduled_execution requires project-write (or all with sandboxMode=sandbox) tool mode`（修复前：201 且静默存成 project-write） |
| `project-write` + `sandboxMode=sandbox` | **400** `sandboxMode "sandbox" requires toolMode "all": …the sandbox never activates`（修复前：201，sandboxMode 无效） |
| `all` + `sandboxMode=sandbox` | **201**，触发后在 node34 上生效策略为 **L2 / `sandboxAvailable:true` / `run_shell` 在工具目录中** |

**同一意图的前后对比**（这就是 D2 的意义）：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 生效 `toolMode` | `project-write` | **`all`** |
| `toolPolicy.maxRiskLevel` | **L1** | **L2** |
| `sandboxAvailable` | **false** | **true** |
| `run_shell` | 不在工具目录 | 在工具目录 |

**测试**：`policy.test.ts` 新增配对规则用例（含"`workspace-write` 是有效组合、不得误伤"的负向控制）8/8 通过；
`scheduled-work-routes.test.ts` 新增回归用例（断言路由**不再**把 `read-only` 改写成 `project-write`）6/6 通过。

**本次连带测出的新缺陷（D4，未修）** `[E]`
该次成功的远端 run **被 goal self-check 判为 `blocked`**，理由 `agent produced no meaningful output`；
但同一会话的 `model.response` 里实际产出了请求的字符串（`SMOKE2_1791694145`）⇒ **self-check 假阴性**（把做对了的 run 拦下）。
建议：self-check 的"有无产出"判据应基于**已记录的输出/事件**而不是另算一遍；并把判负依据写进 `verification_records`
（与 D3 同源：调度路径的门禁缺乏可核对的记录）。

### 第二批：D3 步 1 + D4 + 凭据回退（同日实施，真机验证）

- **凭据回退**：`scheduled-task-runner.ts` 在模板未给 `agentKey` 时回退到网关自身的 `config.executor.agentKey`
  ⇒ 调用方不再需要各自持有 agent 密钥。**实测**：模板 `executor` 无 `agentKey`（创建响应确认 `present = False`）
  仍触发 **succeeded** 且落点 `node34-executor-1`（修复前同一情况是 `unauthorized`）。
- **D4（自检结论留证 + 文案准确）**：`goal-self-check-runner.ts` 在 `task.self_check_completed` 之后
  写入 `verification_records`（`check_name=goal_self_check`，`kind=assertion`，`reviewer=self-check-judge`，
  `independence=separate_model`，状态按 skipped/passed/failed 落库）；
  `self-check.ts` 的判负文案由"produced no meaningful output"改为**准确描述**
  （`agent output too short to judge (N < 20 chars)`）。
  **实测**：同一次运行查询到 `goal_self_check | assertion | succeeded`。
- **D3 步 1（让"没检查"可见）**：声明了 `requiredChecks` 但调度路径从不执行它们（源码层零引用），
  现在**逐条写入 `skipped` + 原因** `scheduled_path_does_not_execute_required_checks`。
  **实测**：`required_check_1 | command | skipped | scheduled_path_does_not_execute_required_checks`。

### 第三批：D3 步 2 的**本地半边**已完成（真机对照验证）

- **执行器接缝**（`verification-runner.ts`）：`runVerificationRecord` 增加可注入的 `commandRunner`
  （默认仍是本机 spawn）；新增 `runDeclaredChecksForTaskRun()`——按 **task run** 工作
  （`runVerificationRecordsForRunSpec` 是按 run spec 工作的，而调度 run 没有 run spec，这正是 D3 的结构性原因）。
- **调度路径接线**（`goal-self-check-runner.ts`）：本地 run ⇒ **真的执行**声明式检查并把结果落证；
  远端 run ⇒ 记 `skipped` + 原因 `remote_run_required_checks_need_node_execution`
  （**绝不在网关本地代跑节点路径的检查**）。
- **真机对照（同一 `uname -s` 检查）** `[E]`：

  | run | 落点 | 检查记录 |
  | --- | --- | --- |
  | 本地（无 executor） | `gateway-local` | `required_check_1 \| **succeeded** \| out=Darwin` |
  | 远端（`node34-executor-1`） | `node34-executor-1` | `required_check_1 \| **skipped** \| skip=remote_run_required_checks_need_node_execution \| out=(空)` |

  ⇒ 本地真执行（Darwin 即网关主机），远端不代跑（输出为空）——两条都是刻意验证的安全属性。
- **测试**：新增 `verification-runner.test.ts` 2/2，其中一条负向断言**执行器不得被调用**（防"远端检查在本地跑"回归）。

### 第四批：self-check 跳过语义改为 operator attention（② 已定稿实施）

**问题**：判官**根本没评过**（输出为空/过短）却被当作"目标未达成"硬拦，文案还谎称"没有产出"
——实测一个 16 字符的**正确**回答 `SMOKE2_1791694145` 即被如此拦下（根因：`self-check.ts:57` 的 `MIN_OUTPUT_CHARS = 20`）。

**改法**（照本仓既有 operator-attention 范式，即 confidence gate 的写法）：
`goal-self-check-runner.ts` 在 `selfCheckResult.skipped` 时走独立分支——
`transitionExecutionState(to:'blocked', reason:'self_check_skipped_needs_operator_attention')`
+ `blockReason` 写明"判官未评、目标既未证实也未否定、需人看一眼"
+ **创建 P1 review todo**（`source='self_check_skipped'`，这是"交给谁看"的落点）
+ **跳过**失败反思/DLQ 那条路（判官没评过，反思无意义）。

**硬约束（已守住）**：**不自动放行**——`succeeded` 不会被置上；"判官判过且没过"仍走原来的 `goal_self_check_failed` 路径。

**真机对照** `[E]`：

| 场景 | 调度运行 | task | 留证 | operator todo |
| --- | --- | --- | --- | --- |
| 短输出（`Reply exactly: OK`） | failed（**电路熔断语义未改**） | `blocked` + `blockReason=Self-check did not run (output_too_short)…` | `goal_self_check \| skipped \| output_too_short`；`required_check_1 \| succeeded` | **P1 / source=`self_check_skipped`** |
| 长输出（负向控制） | **succeeded** | succeeded | — | 无 |

**刻意未改**：调度运行级状态仍是失败（`runner.ts:463` 注释写明"blocked/cancelled/failed → surface as run failure for circuit breaker"）。
把"需要人看"变成不计入熔断的新状态会改变 13 条存量 schedule 的重试行为，属策略决定；**当前人可见的落点是 P1 todo 与 blockReason**。

### 第五批：远端检查通道（① 的远端半边，代码完成；验收受**部署**限制）

**新增受治理的节点命令 `run-check`**（在节点本地执行一条声明式检查），并把命令名清单**收敛成一份**：

| 落点 | 改动 |
| --- | --- |
| `packages/agent/src/node-commands.ts` | `NodeCommandName` += `run-check`；新增 `NODE_COMMAND_NAMES` / `isNodeCommandName` 作为**唯一清单**；`NodeCommandRuntime` 增加 `'run-check'` 槽位 |
| `packages/executor/src/node-command-runner.ts` | 实现处理器：`spawn(command, {shell:true, cwd, timeout})` → 返回 `{status, output:{exitCode,stdout,stderr,timedOut,cwd,command}}`（mac/linux 与 win 两支都注册） |
| `packages/executor/src/executor-helpers.ts`、`packages/gateway/src/routes/orchestration/node-command-routes.ts` | 原先各自维护一份枚举（**三处重复**）⇒ 改为委托 `isNodeCommandName`（加命令时不会再"一边接受一边抛错"） |
| `packages/agent/src/scheduler/node-check-runner.ts`（新） | 网关/agent 侧的客户端：解析节点 `agent_http.commandUrl`，以 agent key 发送 `run-check`，把节点响应映射成 `VerificationCommandResult` |
| `packages/agent/src/scheduler/declared-checks.ts`（新） | 决定**在哪台机器执行**：本地 run 本机跑；远端 run 走节点通道；**没有通道时记 skipped + 原因，绝不本地代跑** |

**真机验收（node34）** `[E]`

| 场景 | 检查记录 | 说明 |
| --- | --- | --- |
| 远端（`node34-executor-1`） | `required_check_1 \| **failed** \| err=node command failed: 422 {"error":"command is required"}` | **不再 skipped**；错误里引用的是**节点自己的响应** ⇒ 通道确实送达节点；输出为空 ⇒ **没有本地代跑** |
| 本地（负向控制） | `required_check_1 \| **succeeded** \| out=Darwin` | 路由重构后本地路径无回归 |

**测试**：executor `node-command-runner.test.ts` 2/2（含"没有命令 ⇒ 明确失败"）；agent `node-check-runner.test.ts` 3/3
（含"节点拒绝不得假装成功"与"没有端点时报错、**不本地代跑**"两条负向断言）。

**⚠️ 剩余的是部署而不是代码**：node34 的 executor 仍是旧码（所以回 422），要让远端检查真正跑出结果，
需要把本批代码**推送到远端并升级节点**（节点已有受治理的 `upgrade` 命令：`git pull` + 重启）。
本批改动都在本地 jj 里、尚未推送，因此这一半的"跑出真实结果"验收**卡在发布动作**上，不是卡在实现。

**仍未修 / 待决策**
- **D3 步 2 的远端半边**（第 2 轮，落点已定）：
  ① executor 侧 `/v1/nodes/:id/commands` 处理器（`packages/executor/src/index.ts:182`）增加一条**受治理的检查命令**（cwd/timeout/输出上限）；
  ② 网关 `node-command-routes.ts:108` 的 `normalizeCommand` 枚举放行该命令；
  ③ 调度接线把该命令包成 `commandRunner` 注入（与 chat 路径注入 `remoteCommandRunner` 同款）。
  ⚠️ 不能复用现有节点命令通道：其枚举被限定为 `status/probe/drain/promote/restart/upgrade/rollback`。
- **检查结果是否参与判定**（待决策）：本轮**刻意只留证、不改变 run 终态**——改成"检查失败即拦"会影响
  13 条存量 `scheduled_execution`（含每 6h 运行的 `schedule-fleet-consistency-001`），属策略决定。
- ~~**D4 的判定语义**~~：**已定稿并实施**（见第四批）——跳过走 operator attention（todo + 独立 reason），不自动放行。

## 6. 不做 / 拒绝清单

1. 不因为 D1 就把 `scheduled_execution` 放宽成支持 `read-only`——执行模板本就是写路径；要的是**说清楚**，不是改语义。
2. 不在 `resolveToolPolicy` 里为 D2 直接调换分支顺序而不评估 chat 语义（那会把本地 `project-write + sandbox` 从 L1 变成 L2）。
3. 不让 `requiredChecks` 在调度路径"静默成功"（宁可 skipped + 原因，也不要零记录）。

## 7. 证据边界

- **CONFIRMED**：§2 四环的 `file:line`；`run_template_json` 里存成 `project-write`；远端 `session.started.toolPolicy` 的 L1/`sandboxAvailable:false`；`verification_records` 近 10 分钟 0 条；表结构含 `task_run_id`/`skip_reason`。
- **INFERRED**：D3 步 2"跨设备任务应要求 `all+sandbox`"是设计建议（未实现、未验证）；远端 `linux-bwrap` 是否真被判为 available 未在远端实跑验证（本地实测为 true）。
- **未验证**：修 D1/D2 后远端 run 是否真能拿到 L2（需一次新的 smoke，判据见 §4 D2 验收）。
