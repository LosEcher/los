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

**仍未修**：D3（调度路径 `requiredChecks` 不执行也不留证，本次实测仍为 **0 条 `verification_records`**）、
凭据注入（调用方仍需自带 `agentKey`）、D4。

## 6. 不做 / 拒绝清单

1. 不因为 D1 就把 `scheduled_execution` 放宽成支持 `read-only`——执行模板本就是写路径；要的是**说清楚**，不是改语义。
2. 不在 `resolveToolPolicy` 里为 D2 直接调换分支顺序而不评估 chat 语义（那会把本地 `project-write + sandbox` 从 L1 变成 L2）。
3. 不让 `requiredChecks` 在调度路径"静默成功"（宁可 skipped + 原因，也不要零记录）。

## 7. 证据边界

- **CONFIRMED**：§2 四环的 `file:line`；`run_template_json` 里存成 `project-write`；远端 `session.started.toolPolicy` 的 L1/`sandboxAvailable:false`；`verification_records` 近 10 分钟 0 条；表结构含 `task_run_id`/`skip_reason`。
- **INFERRED**：D3 步 2"跨设备任务应要求 `all+sandbox`"是设计建议（未实现、未验证）；远端 `linux-bwrap` 是否真被判为 available 未在远端实跑验证（本地实测为 true）。
- **未验证**：修 D1/D2 后远端 run 是否真能拿到 L2（需一次新的 smoke，判据见 §4 D2 验收）。
