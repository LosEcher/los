# 2026-07-19 Web-first Daily Agent Workflow Design

## 结论

LOS 的下一阶段应以 Web 为日常主入口，不优先补完整 TUI。产品结构从当前的
Chat、Sessions、Todos、Tasks、Run Specs、Artifacts 并列页面，调整为三个主工作面：

1. `Inbox`：今天需要处理的计划、审批、失败、验证和定时结果。
2. `Work`：围绕一个工作项查看目标、计划、run、工具、diff、验证、恢复和交付。
3. `Schedules`：管理用户级定时 Agent 工作、下一次运行、并发策略和失败熔断。

后端不需要重新定义 Agent runtime。现有 `todos` 继续作为工作项事实源，
`run_specs`、`task_runs`、`sessions`、`verification_records` 和 artifacts 继续拥有各自证据。
新增的核心结构只有工作项与多次运行的关联、用户定时任务定义、定时触发记录和
面向 Web 的聚合 read model。

`cantool` 和 `lot2extension` 是两类适配参考，不是 LOS 内部模块：

- `cantool` 提供本地能力投影、数据授权、工具审批、checkpoint/resume 和插件隔离模式。
- `lot2extension` 提供业务采集、原子 claim、重试退避、超时回收、结果回调和浏览器运行边界。
- LOS 继续拥有用户意图、run contract、Agent 执行证据、人工决策和最终验证。

## 范围与证据边界

本文是设计和实施拆分，不声明相关 runtime 已完成。

证据标记：

- `[E]`：由 2026-07-19 的代码、数据库、HTTP 或 jj 命令验证。
- `[I]`：由多个已验证事实推断，仍需实现或 live smoke。
- `[U]`：尚未验证，只能作为后续决策项。

本轮读取：

1. LOS 当前 Web、run、session、todo、scheduler、verification contract 和数据库聚合。
2. LOS 数据库中 2026-06-15 至 2026-07-19 的 114 个 task runs 和 119 个 sessions。
3. `cantool`、`lot2extension` 从 2026-03-01 起的 jj 非 merge 提交记录和关键实现。
4. `cantool` 的 Agent capability/tool loop/plugin host 设计与实现状态。
5. `lot2extension` 的浏览器 scheduler、Go scheduler 和 LOS feed-analysis 回调路径。

限制：LOS 数据库当前只覆盖约五周，不能代表“最近几个月”的完整 Agent 使用历史。
两个参考项目的提交主题可以说明重复工作类型，但提交数量受拆分粒度和自动交付提交影响，
不能当作工时或需求权重。

## 当前观察

### 1. LOS 已有执行原语，但日常对象是分散的

`packages/web/src/App.tsx` 当前把 Chat、Sessions、Todos、Memory、Artifacts 放在
Workspace 区，把 Tasks、Run Specs、Evals、Nodes 和 Logs 放在 Operations 区。[E]

Run Specs 页面已支持 approve、reject/cancel 和 verify；Chat 已支持工具审批、steering
和 cancel；Tasks 页面已支持 inspect、recover、verify 和 graph 读取。[E]

这些动作尚未围绕一个用户目标聚合。用户需要自行从 todo 找 session，再从 task 找
run spec，再去 artifacts 或 session timeline 判断结果。[E]

### 2. 当前实际使用偏读取和审计

数据库当前有 114 个 task runs：[E]

| 状态 | 数量 |
| --- | ---: |
| succeeded | 93 |
| failed | 19 |
| blocked | 1 |
| cancelled | 1 |

96 个 run 是 attempt 1，18 个是 attempt 2。完成 run 的平均时长约 106.2 秒，
P50 约 7.1 秒，P95 约 69.9 秒。平均值高于 P95，说明存在少量长尾，调度和 Web
不能只展示平均耗时。[E]

工具事件中 `read_file`、`search_content`、`list_directory` 和 `directory_tree` 占主导；
持久化 tool states 中写操作只有少量记录。`run_shell` 有 33 次失败、2 次成功，
`read_file` 有 17 次失败。[E]

判断：第一版 Web 日常工作流应先把“读取、计划、证据审查、有限写入、验证”做稳定，
不应以无人值守的大范围代码修改作为默认场景。[I]

### 3. Run contract 和验证尚未成为默认路径

113 个 run specs 中，89 个没有 `mode`，100 个没有 `phase`。已记录的 mode 只有
13 个 `execution` 和 11 个 `feed-analysis-ingress`。[E]

数据库只有 2 条 verification records，覆盖 1 个 run spec，没有通过 task run id
覆盖日常任务。事件中有 27 次 `operator_attention_required` 和 14 次
`run.operator_attention_required`，但只有 2 次 `operator.steering`。[E]

判断：Web 新建工作不能继续直接退化成只有 prompt 的 `/chat`。入口必须生成结构化
contract draft；需要人工处理的 run 必须进入 Inbox，并给出明确的下一动作。[I]

### 4. 使用时间适合“交互工作 + 空闲时执行 + 次日审查”

当前 run 主要出现在 15:00、16:00 和 22:00，周六、周日数量高于单个工作日。[E]

判断：定时功能的第一价值不是通用 cron 编辑器，而是把夜间只读检查、预先批准的
有限任务和次日结果审查放进统一证据模型。[I]

### 5. `cantool` 的重复任务类型

2026-03 至 2026-07 的非 merge 提交由 59、19、94、223、414 条组成。主题词统计有
重叠，但持续出现 UI/launcher、clipboard/snippet/file/library、plugin、runtime/release、
verification 和 governance/VCS。[E]

2026-07 的实现已经包含 `AgentCapabilityService`、provider-neutral sampler、
`AgentToolLoop`、DataGrant、MCP 投影和隔离 plugin runtime。[E]

可迁移到 LOS 的不是 CanTool 产品 UI，而是以下约束：[I]

1. 能力声明、运行可用性和真实执行必须分开。
2. 工具副作用风险和数据向在线 provider 披露的风险必须分开。
3. 本地私有内容需要 session/provider 绑定的授权和预算。
4. checkpoint 只保存恢复所需引用，不复制完整敏感结果。
5. 外部插件能力通过稳定 adapter 进入，不直接暴露内部 command registry。

### 6. `lot2extension` 的重复任务类型

2026-03 至 2026-07 的非 merge 提交由 157、73、48、41、58 条组成。持续出现
media/download、feed analysis、auth/session、logging/diagnostics、scheduler/queue 和
live browser verification。[E]

Go scheduler 已有 PostgreSQL 原子 claim、`next_run_at`、retry count、30 秒到 30 分钟
的指数退避和确定性 jitter、30 分钟 stale-running 回收、task result 持久化和 DLQ
路径。[E]

浏览器 `extension/entrypoints/background/scheduler.ts` 是轻量本地脚本定时器，只支持
interval、`HH:mm` 和一次性 nextRun，配置存于 extension local storage；它不是通用
可靠任务队列。[E]

feed-analysis 已通过 LOS integration contract 支持 dispatch、status、result、cancel
和 callback，完成结果平均约 39.6 秒；当前 11 个 dispatch 中 6 completed、4 failed、
1 cancelled。[E]

判断：浏览器驻留动作继续由 extension 所有，lot2 业务任务继续由 Go scheduler 所有，
LOS 只拥有用户级 Agent 工作和跨系统关联。三个 scheduler 通过 idempotency key、
source job id、run spec id 和 callback event 关联，不能共享一套状态字段。[I]

## 产品对象

### `Project`

项目定义 workspace、默认 provider policy、tool policy、验证 profile、VCS 类型、
可用 connectors 和用户时区。现有 project/tenant scope 继续使用，不把绝对路径当项目 id。

### `Work Item`

Web 使用 `Work Item` 作为用户可见对象，第一阶段以后端现有 `todos` 为事实源：

- `goal`：要达到的结果。
- `mode`：audit、execution、closeout、governance 或 integration ingress。
- `scope`：workspace、editable surfaces、owner layer。
- `acceptance`：required checks、verification、stop conditions。
- `status`：继续使用现有 todo 状态机；Web 另外派生 `needs_attention`、`review_ready`
  和 `verification_blocked`，不把这些 read-model 状态直接写回 `todos.status`。
- `links`：多次 run、session、artifact、schedule 和外部 job。

不在 `todos.metadata_json` 中长期堆叠多次运行。新增 `work_item_runs` 关联表，允许一个
工作项有 planning run、execution attempt、verifier run、recovery run 和 closeout run。

### `Run`

`run_specs` 继续拥有不可变执行输入和 run contract，`task_runs` 继续拥有一次 attempt，
`sessions` 继续拥有交互上下文，`session_events` 继续拥有 replay 事件。Web 可以合并显示，
但不能把它们改成一个数据库状态机。

### `Review`

Review 是 read model 和一组 operator action，不新增独立状态真相。它聚合：

- plan approval；
- tool/data approval；
- operator attention；
- diff review；
- verification failure or missing evidence；
- recovery decision；
- VCS closeout decision。

### `Schedule`

Schedule 是“何时创建或继续一个工作项运行”的定义，不是正在执行的 task。每次触发都
创建 `scheduled_work_item_runs`，再通过现有 run/task API 生成可追踪的 run spec 和 attempt。

## Web 信息架构

```text
Inbox
  needs approval | failed/recoverable | verification blocked | scheduled results

Work
  list / project filter / status filter
    Work Item
      Overview | Plan | Run | Changes | Verification | Activity

Schedules
  definitions | calendar/list | run history | circuit and retry state

Library
  Sessions | Artifacts | Memory

Configure
  Projects | Providers | Skills | MCP | Connectors | Rules | Settings

Operations
  Tasks | Run Specs | Nodes | Services | Evals | Logs | DLQ | Diagnostics
```

现有 Operations 页面保留用于诊断。日常使用不要求用户理解 run spec、task run 和
session 的区别；Work Item 详情在需要时提供原始 id 和深链接。

### 默认首页 `Inbox`

Inbox 只显示可行动条目，按严重度和等待时间排序：

1. `approval_required`：计划、写工具、私有数据或高风险操作等待授权。
2. `recovery_required`：失败、orphaned、lease expired 或 provider fallback exhausted。
3. `verification_blocked`：required check 缺失、失败或结果过期。
4. `review_ready`：diff、artifact 或定时结果等待审查。
5. `running`：当前 active run，显示阶段、耗时和停止按钮。

每条只展示一个主动作，例如 `Review plan`、`Recover`、`Inspect failed check` 或
`Review changes`。低级工具事件留在 Activity，不占用 Inbox。

### `Work Item` 详情

顶部固定显示 goal、mode、project、scope、当前 phase、owner、运行时长和下一动作。

| Tab | 内容 | 主要动作 |
| --- | --- | --- |
| Overview | acceptance、风险、run lineage、外部关联 | start、cancel、archive |
| Plan | persisted plan、editable surfaces、required checks | approve、revise、reject |
| Run | live response、tool calls、steering、attempts | steer、stop、recover |
| Changes | jj diff、artifact、workspace backup | approve changes、request revision |
| Verification | required/actual checks、output summary、reviewer | rerun、record skip reason |
| Activity | session events、operator events、external callbacks | filter、replay、copy evidence id |

`Changes` 首期可以从 managed workspace artifact 和 diff backup 读取，不实现在线编辑器。
文件修改仍由 coding tools 完成。

## 日常操作流程

### 1. 新建工作

1. 用户选择 project，输入目标，可选附件或外部对象。
2. Web 创建 todo/work item 和 `run_contract` draft，不直接进入 execution。
3. audit/read-only 任务可按 project policy 自动进入 discovery；写任务生成计划。
4. Agent 返回 plan、scope、风险和 required checks，持久化后进入 Inbox。
5. 用户批准、修改或取消计划。

对于显式标记为“快速读取”的任务，可以用预定义 contract template 跳过人工 plan
approval，但仍需记录 mode、scope、tool mode 和 stop condition。

### 2. 执行和介入

1. 批准后由现有 scheduler 创建 task run。
2. Web 使用 session event cursor 恢复流，不以当前 SSE 连接作为完成事实。
3. policy denial、provider fallback exhaustion、tool retry exhaustion 和 verifier block
进入 Inbox。
4. operator steering 记录 instruction、reason、turn boundary 和目标 run。
5. 继续执行时创建明确 attempt 或 follow-up，不覆盖原事件。

### 3. 验证和完成

1. executor 结束后进入 `verifying`，不直接显示完成。
2. required checks 转成 verification records；命令、状态、摘要和 artifact ref 可审查。
3. `canMarkSucceeded()` 通过后，工作项进入 `review`，而不是自动进入 `done`。
4. 无代码变更的 audit 可以按 policy 自动 done。
5. 有 diff 的 execution 需要 operator 接受结果，VCS closeout 另行执行。

### 4. VCS closeout

1. 显示 jj change、bookmark、workspace、diff artifact 和 checks。
2. 默认允许创建描述清晰的本地 change；push、PR、merge、远端删除遵循项目授权。
3. managed workspace release 先保存 diff artifact，再执行精确确认的 release。
4. Work Item 只有在 acceptance、verification 和 closeout policy 都满足后才标记 done。

## 用户定时任务设计

### 所有权

新增 `scheduled_work_items`，不复用 `governance_jobs`：

- `governance_jobs` 继续拥有 LOS 自身健康和治理检查。
- `scheduled_work_items` 拥有用户目标和 Agent run 模板。
- 外部 connector 的 scheduler 继续拥有外部业务任务。

三者可复用相同 library-level claim/circuit policy，但各自使用独立 contract 和表。

### Schedule contract

```ts
type ScheduledWorkItem = {
  id: string;
  projectId: string;
  sourceWorkItemId?: string;
  title: string;
  enabled: boolean;
  trigger: {
    kind: 'cron' | 'interval' | 'once';
    expression: string;
    timezone: string;
  };
  runTemplate: {
    mode: 'audit' | 'execution' | 'closeout' | 'governance';
    goalTemplate: string;
    editableSurfaces: string[];
    requiredChecks: string[];
    providerPolicyRef: string;
    toolPolicyRef: string;
  };
  approvalPolicy: 'read_only_auto' | 'preapproved_scope' | 'each_run';
  concurrencyPolicy: 'skip' | 'queue_one' | 'parallel';
  catchUpPolicy: 'skip' | 'run_once';
  maxLatenessMs: number;
  nextRunAt: string;
  circuitState: 'closed' | 'open' | 'half_open';
};
```

第一阶段不实现自然语言 cron。Web 用 preset 加结构化字段生成 cron，保存时显示下一次
三次触发时间和时区。

### 运行策略

默认策略：

| 任务 | 是否可无人值守 | 默认结果 |
| --- | --- | --- |
| runtime health、队列深度、doc/source drift、repo 状态 | 是，read-only | Inbox 摘要或无变化静默 |
| 研究、计划、依赖分析、变更建议 | 是，read-only | review_ready |
| 明确 editable surfaces 的有限代码修改 | 仅 `preapproved_scope` | verification 后 review_ready |
| live browser 登录态操作、私有内容上传 | 否 | each_run approval |
| credential、plugin install、release、push/merge、远端删除 | 否 | operator approval/user presence |

连续无变化采用 `consecutive_no_ops` 降频建议，不自动改变 schedule。连续失败达到阈值后
打开 circuit，将一个 recovery item 放入 Inbox；half-open 只允许一次探测运行。

### 推荐的首批定时模板

1. `Morning inbox digest`：汇总昨夜结果、失败、待验证和待审批，不调用 provider。
2. `Nightly project audit`：read-only 检查 jj status、TODO、失败 tests 和文档漂移。
3. `Weekly project review`：生成项目进展、重复失败和 eval 候选，等待审查。
4. `Scheduled feed analysis`：通过现有 lot2 integration dispatch，回调后进入 Inbox。
5. `Runtime readiness`：复用 LOS daily governance 结果，不创建重复 agent run。

## `cantool` 适配

### 目标

让 LOS 在需要桌面能力时通过已治理的 CanTool capability adapter 调用，而不是把
CanTool 的 Rust domain、Tauri command 或 plugin host 移入 LOS。

### 边界

1. CanTool 通过 MCP 或后续本地 RPC 暴露 provider-neutral descriptors。
2. LOS MCP lifecycle 负责 inspect、apply、verify、enable、pin 和 rollback。
3. LOS project connector 保存 server/profile ref，不复制 credential。
4. CanTool 继续执行 DataGrant、plugin trust、local-only secret 和 user-presence policy。
5. LOS 记录 capability id、policy decision、duration、result digest 和 artifact ref，
   不记录完整 clipboard/file/snippet 内容。

### 首批能力

首期只接入：runtime/plugin status、file index status、不含内容的本地统计，以及
caller-supplied 纯转换、calculator、regex 和 unit conversion。clipboard/snippet 内容、
file search/recent/excerpt、secret、窗口控制、paste/write、plugin tools 和未审查的新能力
保持 blocked；当前 stdio bridge 不转发 DataGrant，因此不能通过 LOS 侧 grant-shaped
evidence 解锁。

## `lot2extension` 适配

### 目标

把“浏览器采集 -> 业务处理 -> Agent 分析 -> 结果回传”作为外部工作流模板，继续复用
`contracts/integration-feed-analysis.yaml`。

### 调度责任

| 动作 | Owner |
| --- | --- |
| 页面按钮、浏览器 alarm、MV3 worker、登录态 DOM | lot2 extension |
| media scrape、browser visit、业务 retry/DLQ | lot2 Go backend |
| 分析目标、run contract、provider、tool policy、verification | LOS |
| 结果映射和业务状态更新 | lot2 callback service |
| 跨系统审查和 operator decision | LOS Inbox |

所有跨系统请求携带 `sourceSystem`、`sourceJobId`、`sourceSessionId`、`idempotencyKey`、
`runSpecId`、`traceId` 和 contract version。外部系统状态显示为关联证据，不覆盖 LOS
run 状态。

### 后续模板

在 feed-analysis 稳定后，可将 browser visit、媒体处理结果审查和定时采集摘要接入同一
connector 规范。不能直接把 lot2 的通用 task API 映射成 LOS 任意 shell/tool 权限。

## Contract、存储和模块落点

### Contracts first

建议新增或更新：

1. `contracts/work-item.yaml`：todo projection、run links、next action、review state。
2. `contracts/scheduled-work-item.yaml`：schedule、trigger、approval、concurrency、circuit。
3. `contracts/run-spec.yaml`：只增加 schedule/work item correlation id，不复制 schedule policy。

CanTool 首期复用 project-scoped MCP server records，lot2 首期复用现有 feed-analysis
integration records。只有多个 connector 出现共同的 version/health/policy 查询需求后，
才新增 `project-connector` contract；P0 至 P3 不为抽象统一而创建该表。

### PostgreSQL

```text
todos                         existing work-item truth
work_item_runs               todo_id <-> run_spec/task_run/session lineage
scheduled_work_items         schedule definition and current circuit state
scheduled_work_item_runs     trigger, claim, dedupe, run_spec, outcome
```

`scheduled_work_item_runs` 使用唯一键 `(schedule_id, scheduled_for)` 防止重复触发。
claim 使用 `FOR UPDATE SKIP LOCKED`，lease expiry 走统一 recovery event。状态变化必须通过
`transitionExecutionState()` 或为 schedule 定义等价的唯一 transition owner，不能从 route
直接更新 status。

### Packages

| 层 | 建议落点 |
| --- | --- |
| work item projection | `packages/agent/src/work-items/` |
| schedule contract/policy | `packages/agent/src/scheduled-work/` |
| schedule persistence | 现有 infra DB owner 下的 agent store，不新增 package |
| HTTP routes | `packages/gateway/src/routes/orchestration/` |
| Inbox read model | `packages/gateway/src/routes/data/` 或独立 query module |
| Web | `packages/web/src/pages/inbox-page.tsx`、`work-page.tsx`、`schedules-page.tsx` |
| connector adapters | 现有 project-scoped MCP/integration owner，不建立直接 repo dependency |

具体编码前需用 ADR 确认 schedule state machine 和 store owner。本文不授权直接增加
`packages/infra/` 文件。

## 权限、恢复和数据治理

1. project policy 只能缩小 global tool policy，schedule 只能进一步缩小 project policy。
2. `preapproved_scope` 绑定 project、mode、editable surfaces、tool tier、provider location、
   expiry 和 schedule revision；任一变化使授权失效。
3. online provider 的本地私有数据读取需要独立 data grant，不由 `read-only` 自动授权。
4. operator token 只用于人工动作，不放入 schedule payload 或 provider context。
5. schedule retry 不重放已进入 side-effect gateway 的非幂等工具。
6. recovery 创建新 attempt，保留原 task、tool state、verification 和 event cursor。
7. 外部 callback 必须验证 credential/signature、sequence 和 idempotency key。
8. Web read model 默认显示 redacted summary，原始 tool input/output 按现有权限单独读取。

## Observability 与 eval

### 必须记录的指标

- work item lead time：created 到 done。
- attention wait time：进入 Inbox 到 operator action。
- plan approval rate 和 revision count。
- attempt count、retry reason、recovery success rate。
- scheduled lateness、skip、queue、circuit open 和 no-op count。
- required verification coverage 和 pass/skip/fail。
- diff accepted、revision requested 和 closeout completed。
- connector dispatch/callback latency 和 status mismatch。

### 首批 eval

1. 没有 mode/phase 的 Web prompt 不得直接进入写执行。
2. required verification 缺失时 Work Item 不得显示 done。
3. 一个 operator attention event 必须产生 Inbox item 或明确的自动 policy outcome。
4. SSE 断开后按 cursor replay，不重复展示 operator action 或 tool result。
5. schedule 重复 claim 只创建一个 scheduled run。
6. 非幂等工具执行后崩溃，recovery 不自动重放。
7. lot2 callback completed 但没有 validated result 时保持 blocked/failed。
8. CanTool local-private 结果不能在没有 matching grant 时返回 online provider。
9. 外部 scheduler failed 不直接把 LOS run spec 改成 failed，必须按 correlation policy 映射。
10. managed workspace 没有 diff backup 时不能 release。

## 实施阶段与验收

### P0. 日常工作 read model

目标：不改执行状态机，先把现有证据聚合成可用 Web 主路径。

1. 定义 `work-item` contract 和 `work_item_runs`。
2. 新增 Inbox query，覆盖 approval、operator attention、verification、failure 和 review。
3. 新增 Work list/detail，把现有 run/session/task/artifact 深链接收进一个页面。
4. Web 新建工作强制生成 mode、goal、scope 和 completion contract draft。

验收：

- 从新建目标到 plan approval 不需要进入 Operations 页面。
- 现有 27 条 operator attention 可被 read model 分类，无法分类的进入 explicit unknown。
- 新建 Web run 不再产生 `mode=(none)`。
- focused gateway/web tests 和 `pnpm check` 通过。

### P1. 验证与变更审查

1. 把 required checks 生成 verification records。
2. Work detail 展示 verification 和 managed workspace diff artifacts。
3. succeeded 和 work item done 保持独立，增加 operator result acceptance。
4. closeout report 聚合 dirty paths、jj change/bookmark、checks 和 residual risk。

验收：

- 每个 execution run 至少有一条 required verification 或 explicit allowed skip。
- verification coverage 可按 project/mode 查询。
- 有 diff 的 work item 未审查前不会显示 done。
- recovery、verification、managed workspace harness 通过。

### P2. 用户定时任务

实现状态（2026-07-19）：contract、migration、agent policy/store/runner、gateway
operator API 和 Schedules Web 页面已进入当前 working copy。focused agent、gateway、
Web boundary、desktop/mobile Schedules、migration drift、`pnpm check` 和
cross-package gate 均已通过。重启后的 authenticated live smoke 验证了 trigger preview、
创建、手动触发、run history 和 Inbox 投影；相同 `(schedule_id, scheduled_for)` 的第二次
触发返回 409，history 仍只有一条 run。smoke schedule 随后已设为 `retired`。

1. ADR 定义 schedule state、claim、lease、retry、circuit 和 approval policy。
2. 新增 schedule contracts、migration、store、scheduler runner 和 API。
3. 新增 Schedules Web 页面、下一次触发预览和 run history。
4. 先上线 read-only templates，再开放 `preapproved_scope`。

验收：

- 双 scheduler 实例不能重复触发同一 `(schedule_id, scheduled_for)`。
- timezone、DST、catch-up、concurrency 和 circuit 有 deterministic tests。
- 失败达到阈值后只生成一个 Inbox recovery item。
- package tests、migration drift、`pnpm check` 和跨包 gate 通过。

### P3. `lot2extension` connector 模板

1. 将现有 feed-analysis projection 纳入 Work Item 和 Inbox。
2. 显示外部 job 与 LOS run 的独立状态和 callback latency。
3. 支持从 Schedule 触发现有 dispatch contract，不复制业务 payload schema。
4. 增加 completed-without-result、duplicate callback 和 out-of-order sequence tests。

验收：现有 dispatch/status/result/cancel/callback live smoke 通过，且重试不产生重复业务结果。

### P4. `cantool` capability adapter

实现状态（2026-07-19）：contract、显式 `generic | cantool` adapter、capability
classification/projection、registry 二次 fail-closed、Web evidence、stdio cancellation
harness 和 packaged runtime smoke 已进入当前 working copy。canonical HTTP lifecycle 已完成
inspect、disabled apply、verify 和 pin，记录 `cantool.smoke.local` 保持 `enabled=false`。
当前 LOS client 与 CanTool 2.0.0-alpha 协商 MCP `2024-11-05`，发现 61 个 tools，投影为
54 available / 7 blocked。

live smoke 验证：`agent.resource.read(cantool://runtime)` 返回结构化 runtime status，
`calculator.evaluate` 返回 42；无 grant 的 `snippet.search` 由 CanTool 返回
`DATA_GRANT_DENIED`。调用取消后同一 client 的新 calculator call 成功；只声明
`new_call_only`，不声明 checkpoint resume。adapter fixture 另覆盖 missing、wrong
provider/location、expired、revoked 和 session mismatch grant evidence；当前匹配 evidence
仍返回 `data_grant_forwarding_unavailable`。

1. 用 LOS MCP lifecycle inspect/pin CanTool server。
2. 首先启用 status 和纯工具，记录 capability availability reason。
3. 增加 provider location 和 DataGrant 映射。
4. 完成 packaged CanTool + LOS 的 disclosure、approval、cancel 和 resume smoke。

验收：local-private fixture 在无 grant、错 provider、过期 grant 和 session change 时均被拒绝。

### P5. 日常质量评估

1. 建立 Web-first scenario corpus。
2. 按 provider/model 比较 task success、verification、attention 和 cost，不混入 runtime health。
3. 用连续四周数据评估 Inbox aging、schedule no-op、recovery 和 verification coverage。
4. 只有指标证明收益后，才扩大无人值守写权限或多 Agent 并发。

## 不做的事项

1. 不先建设完整 TUI、session tree SDK 或通用 extension marketplace。
2. 不把 `cantool` 或 `lot2extension` 作为源码依赖导入 LOS。
3. 不用 `governance_jobs` 承载用户项目任务。
4. 不让 Web 聚合 read model 直接写 task/run/tool 状态。
5. 不把“定时触发成功”当作 Agent run、verification 或外部 callback 成功。
6. 不把 provider configured、runtime selected、health、quota、cost 和 compatibility 合成一个状态。

## 待验证项

1. `[U]` 工作项用户术语最终显示为 `Work`、`Tasks` 还是 `Projects` 下的 `Work`，需用
   当前操作者的一周真实使用验证；数据库仍保持 `todos`，不受文案选择影响。
2. `[E]` P2 使用 `packages/agent/src/scheduled-work/policy.ts` 的受限 daily/weekly preset
   parser，并由 deterministic tests 覆盖 IANA timezone 和 DST；没有复用 lot2 parser，
   也没有开放任意 cron 或自然语言 cron。
3. `[E]` CanTool 2.0.0-alpha packaged runtime 已完成 LOS MCP live smoke：协议
   `2024-11-05`、61 tools、54 available / 7 blocked；status/pure-tool、无 grant denial、
   cancellation 后 fresh call 均已验证。server 记录保持 disabled 且 pinned。
4. `[U]` lot2 当前 4 个 failed dispatch 的失败分类未在本文读取原始错误，P3 前需做脱敏聚合。
5. `[U]` 当前 LOS session resume/branch 没有足够专用事件，P0 需定义 lineage read model，
   不能只从 session metadata 推断。

## 下一决策

P0 至 P4 已在当前 working copy 实现并通过各自聚焦验证。下一实现项是 P5：建立
Web-first scenario corpus、指标查询与基线采集机制。当前数据库只覆盖约五周，因此 P5
只能形成当前 baseline 和后续四周观察窗口，不能虚构连续四周趋势结论。provider/model
效果、runtime health、quota 和 cost 必须继续作为独立维度记录。
