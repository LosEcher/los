# P3 设计：执行可靠性 + 验证债（沙箱升级语义 / 僵尸 run_spec / self-check / AP12 / 死信）

- **状态**：设计（待评审）
- **归属**：全在 **los 侧**（`packages/agent` + `packages/gateway` + `tools/` + `contracts/`）
- **批次**：P3
- **依据**：2026-10-08 盘点 §4.3/§4.4/§5.2（B1/B4/B12/B17 + 死信 14 条 + self-check 14 条 failed）+ DSH 会话实证的沙箱误判
- **前置**：本批次与 P4 无依赖；但 B4 的修复依赖本批次 L3-1 的 `blocked_reason` 枚举

---

## 1. 问题陈述（有数字）

### 1.1 `run_specs` revision 路径产生永不收敛的僵尸（34% 非终止态）

实测（2026-10-08）：

| status | 总数 | 近 30 天 |
| --- | --- | --- |
| succeeded | 392 | 153 |
| **created** | **150** | **20** |
| blocked | 59 | 45 |
| failed | 16 | 14 |
| cancelled | 15 | — |

- **非终止态 = (150+59)/615 = 34.0%**；`created` 跨 **2026-06-16 → 2026-10-08**，永不收敛。
- **近 30 天新增的 20 条里 14 条（70%）来自 gate-probe / revision 路径**，prompt 形态固定：
  - `Gate FAILED for <tool>. This run exists so a revision can be…`
  - `Gate probe for <tool>. Required checks: - documented: …`
- 150 条 `created` 的 `run_contract_json->>'status'` **全为空**、无 plan 标记 ⇒ **不是待审批的计划**，是修订期产生的孤儿。
- 对照：`task_runs` 近 30 天只有 3 个终态（succeeded 358 / blocked 87 / failed 39），**没有 `created`** ⇒ 僵尸只在 `run_specs` 一侧，是**状态机在 revision 路径上缺终态收敛**（AP1 语义缺口）。

### 1.2 `scheduled_execution` 的 self-check 把已完成的 run 记 failed

近 7 天定时任务：succeeded 113 / failed 27 / **no_op 781（约 85% 空转）**，其中 **14 条 failed 是 `Goal self-check failed`**，形态高度集中：

| 自检类型 | 原话（截断） |
| --- | --- |
| `self_check_parse` | `invalid self-check contract: response is not a JSON object` |
| `Staleness gate` | `Agent determined current time by creating .now-probe.tmp…`（要求用真 ISO 时间戳） |
| `Goal requirement (N)` | `transcript's Files written/modified list shows only /tmp/gen_baseline.py`…`despite the final report claiming it was written` |
| `Confidence gate` | 置信度门未达 |
| `terminal_state` | `failed -> cancelled` |

其中 `surge log error analysis (6h) v4` **circuit=open / consecutive_failures=3 / `next_run_at` 已过期（10-08 09:40）**，而 `tools/los-governance-daily.sh` 把它列在"启用的定时任务"表里、**没有计入第 1 节异常**。

**判定**：self-check 把三类不同的事混成一个 `failed`：
- (a) **真失败**（没干活）；
- (b) **干了活但缺交付物证据**（10-07 closeout 已沉淀"run 失败 ≠ 产物无用"）；
- (c) **自检本身解析失败**（`self_check_parse`）——这是**验证器的缺陷**，不是被验对象的缺陷。

### 1.3 沙箱升级语义是全局缺口（DSH 会话实证，los 侧同构）

DSH 近 14 天 FTS：`SANDBOX` **995** 命中、`workspace-write` **253** 命中、`sandbox.*denied` 跨 **≥4 个仓**。原始形态（会话原话）：

| 现象 | 原话 |
| --- | --- |
| **拒绝被误判成幂等命中** | "file sandbox（workspace-write）禁止写 `~/.dsh/storages/feishu-push/`，`mkdir` claim 失败被脚本误判为 `inFlight → dedup:true exit 0` —— **今天这条故障通知根本没发出去，却报了成功**" |
| ssh ControlMaster socket 被拒 | "首次 ssh 被沙箱拦截，原因是它要往 `~/.ssh/cm-*` 写 ControlMaster socket；改用 `-o ControlMaster=no`" |
| `ps` 被拒导致门禁假红 | "4 个失败是已知沙箱产物 —— `ps` 在非升级 shell 里被 block；同一棵树非沙箱下 77/77 通过" |
| 升级被 fail-closed 拒 | "归档未完成——第 4 步写入被沙箱拒绝，且本会话没有可用审批通道（升级请求两次都被 fail-closed 拒绝）" |
| 合法升级 | "Sandbox denied (file is outside the workspace). Retrying the same edit with escalation, as the policy allows." |

**los 侧同构证据**：`packages/agent/src/tools/external/shell-sandbox.ts:132` 的 `resolveSandboxBackend` 只有 OS 级后端（`macos-sandbox-exec` / `linux-bwrap` / `windows-acl` / `native` / `native-denied`），**`native-denied` 是一个终态拒绝**；2026-10-06 四轮实测钉死的风险阶梯（`docs/architecture/2026-10-06-los-execution-surface-and-task-routing.md:108-127`）也说明：`readonly`/`project-write` → L0/L1 `run_shell` 被拒；`sandbox` → L2 但**沙箱内无网络、`/dev/null` 不可写**；`toolMode=all` 定时路径**到不了**。

⇒ **缺口不是"沙箱太严"，而是三件事**：
1. **拒绝原因不可查询**：没有 typed `blocked_reason`，所以调用方/日报无法区分"策略禁止"与"路径不存在"与"权限错"，只能读自然语言；
2. **拒绝与幂等不可区分**：脚本把 `EACCES/denied` 与 `EEXIST` 混为一谈（1.3 表第一行就是恶性后果：故障通知静默丢失且报成功）；
3. **升级路径不统一**：DSH 侧有"同一条命令带更宽模式重试"的形态，los 侧**没有**任何"带理由的、可审计的升级"，只有终态 `native-denied`。

### 1.4 AP12 回写缺失 + 租约过期无重排

- AGENTS.md 的 **AP12**：todo 状态必须跟随 task-run 结局；2026-08-05/08-08 的 feed-analysis 案例已证明"僵尸 `in_progress`"的代价。修复 DAG 里 **P1-12（chat/resume 走 `applyTodoOutcome`）仍"待做"**。
- 死信实测 14 条未确认：13 条 `unrecoverable_error`（`submit_run_contract was not accepted`）+ **1 条 `lease_expired`**。而 P1-6 已记录：`lease_expired` 的 requeue 候选要求 `run_spec_id` 非空，**多数不满足 ⇒ `requeueEligible=0`** ⇒ 租约过期只会**只增不减**。

### 1.5 观测门禁静默失效（B1，直接让治理面失明）

`packages/agent/src/governance-auditors-performance.ts:36-40` 查 `provider_call_telemetry` 的
`latency_ms` / `cost` / `is_error` / `prompt_tokens` / `completion_tokens` —— **五列在该表全部不存在**（真实列 = `duration_ms` / `usage_json` / `status`）。错误被 `:59-61` 的 catch 吞成一行 WARN，结果 `providerStats` / `slowProviders` / `errorProneProviders` 全 0、`totalProviderCalls=0`。证据：`gateway.log:3032`。**性能审计自 2026-10-03 起一直报空**，同类正确写法在 `metrics-trends.ts:150-155`、`usage-summary.ts:236-241`。

同类问题还有：死信治理 job 的 `retired` 僵尸（2 条历史行）、日报漏报 circuit open（1.2）。

---

## 2. 设计目标与非目标

**目标**
1. `run_specs` 在**所有**路径上都有终态收敛；僵尸可被机械发现并自动收敛/归档。
2. self-check 的三种结局**分离**（真失败 / 缺证据 / 验证器缺陷），且**验证器缺陷不得判被验对象 failed**。
3. 沙箱拒绝有 **typed 原因 + 可查询审计 + 统一升级语义**；`denied` 与 `EEXIST` **机械可分**。
4. AP12 回写在 chat/resume 路径补齐；`lease_expired` 有收敛路径（含无 `run_spec_id` 的情形）。
5. 观测门禁**不允许静默报空**：任何审计查询失败必须表现为 degraded 并被日报计入异常。

**非目标**
- 不做 container/VM 隔离（那是 ADR 0046 的候选，见 P4）。
- 不放宽沙箱默认策略（本批次只改**语义与可观测**，不改默认宽度）。
- 不引入通用策略引擎（P1-5 的"工具级三态审计"只做三态事件，不做引擎）。

---

## 3. 交付物

### L3-1 `blocked_reason` 契约化 + 沙箱拒绝三态（contracts 先行）

**契约先行**（AGENTS.md 规则 1）：`contracts/` 增 `blocked-reason.yaml`（或扩展既有 run-spec / task-run 契约），定义枚举：

| 域 | 取值 |
| --- | --- |
| 策略类 | `sandbox_policy_denied`、`tool_mode_denied`、`identity_level_denied`、`approval_required` |
| 资源类 | `path_not_found`、`permission_denied`、`io_error`、`timeout` |
| 幂等类 | `already_exists`（**必须与上面全部区分**）、`duplicate_suppressed` |
| 验证类 | `verification_failed_evidence_missing`、`verification_checker_invalid`、`confidence_below_gate` |
| 规划类 | `plan_not_approved`、`submit_run_contract_rejected`（死信主因） |

**落库**：`task_runs` / `run_specs` / `dead_letter_events` / `verification_records` 增 `blocked_reason`（有值才写，避免全表加宽语义）。`transitionExecutionState()`（AP1 唯一入口）接受并使用该字段。

**沙箱侧三态**：`resolveSandboxBackend` 返回值从字符串改为 `{ backend, decision: 'allow'|'deny'|'escalate', reason: BlockedReason }`；`native-denied` 改名 `deny(sandbox_policy_denied)`，不再是一个无语义终态。

**升级语义**（对齐 DSH 侧可用的形态）：
- 首次拒绝返回 `decision:'deny', reason:<typed>, escalateHint:{ mode: <更宽模式>, justificationRequired: true }`；
- 调用方可用**同一条命令 + 显式 justification** 重试一次（`decision:'escalate'`）；**不自动升级**、不连续重试；
- 每次 deny / escalate 都写 `tool_call_states` 的**三态事件**（allowed / refused / failed，P1-5 的最小形态）——**不做策略引擎**。

**验收**：契约检查绿；`pnpm check:bypass` 绿（不得绕过 `transitionExecutionState`）；新增用例覆盖"deny 与 already_exists 必须给出不同 reason"的负向控制。

### L3-2 僵尸 `run_specs` 收敛（含自动收敛 job）

**三条收敛路径**（按优先级）：

1. **revision 路径显式终态**：gate-probe / revision 产生的 run_spec 在修订完成或放弃时，必须走 `supersede`（新终态）或 `cancelled`，**不得留在 `created`**。
2. **孤儿清扫 job**（新增 governance job `run_spec_orphan_sweep`，hourly）：
   - 候选 = `status='created'` 且 `updated_at < now() - 2h` 且无 `plan_approved` 标记 且无活跃 `task_runs`；
   - 动作 = 标 `superseded`（带 `blocked_reason='plan_not_approved'` 或 `superseded_by_revision`）+ 写事件；
   - **幂等**：重复跑不产生新状态迁移；**可回放**：台账落 `run_specs` 与事件的对应关系。
3. **历史 150 条一次性收敛**：先只读统计 + 抽样核对（确认无活跃引用），再批量 supersede；**先备份**（`\copy CSV`，参照 `scheduled_work_item_runs` 的退役纪律）。

**验收**：近 30 天新增 `created` = 0；历史 `created` 归零或全部有 terminal reason；非终止态占比 < 10%；清扫 job 的重复执行是 no_op。

### L3-3 self-check 三态分离

**问题**：`Goal self-check failed` 把 (a) 真失败 / (b) 缺交付物证据 / (c) 验证器自身解析失败 混成一个 failed。

**设计**
1. **自检结果契约化**：self-check 返回 `{ verdict: 'pass'|'insufficient_evidence'|'checker_error', requirementId, evidenceRefs[], reason: BlockedReason }`。`checker_error` **明确表示"验证器坏了"**。
2. **三态映射**（关键）：
   | self-check verdict | run 终态 | 日报口径 |
   | --- | --- | --- |
   | `pass` | `succeeded` | 正常 |
   | `insufficient_evidence` | `blocked`（`verification_failed_evidence_missing`）**不是 failed** | 计入"缺证据"独立一栏 |
   | `checker_error` | `failed`，但**归因到验证器**（`verification_checker_invalid`），并**自动出 todo** | 计入异常（这是工程债，必须被看见） |
3. **`self_check_parse` 硬化**：非 JSON 响应必须重试一次（带"只输出 JSON"的强化提示）；仍失败 → `checker_error`。禁止把解析失败算成被验对象的失败。
4. **staleness gate 的时间来源**：允许用**已有证据里的时间戳**（如报告自身的 `asOf`）或**系统提供的当前时间**，不得要求 agent 通过创建 `.now-probe.tmp` 来自证——那是把工具缺陷转嫁给被验对象。

**验收**：近 7 天 `Goal self-check failed` = 0；出现 `checker_error` 时 run 记 failed **且**自动生成 todo（负向控制：注入一个非 JSON 自检响应 → 必须走 `checker_error` 而不是 `insufficient_evidence`）。

### L3-4 AP12 回写补齐 + 租约过期收敛

1. **chat/run-resume 走 `applyTodoOutcome()`**（DAG P1-12）：完成/失败/取消三条路径都回写 todo；断言无僵尸 `in_progress`（AP12）。
2. **`lease_expired` 的两条收敛**：
   - 有 `run_spec_id` → 现有 requeue 路径；
   - **无 `run_spec_id`** → 标 `superseded`（带 `blocked_reason='lease_expired_no_spec'`）并**关闭死信**，不再留在"未确认"里。
3. **死信根因收敛**：13 条 `submit_run_contract was not accepted` 归到 `submit_run_contract_rejected`，并排查**为什么计划提交被拒**（是 schema 校验、还是 revision 期间状态竞争）；修复后旧条目按 resolution 分类 ack。

**验收**：`dead_letter_events` unacked = 0 且新条目都有 typed `blocked_reason`；无 `in_progress` 僵尸 todo（SQL 断言）；`lease_expired` 的 `requeueEligible` 不再是恒 0。

### L3-5 观测门禁不许静默失效

1. **修 B1**：`governance-auditors-performance.ts` 改为真实列（`duration_ms` / `usage_json` / `status`），**去掉不存在的 `cost` 列**（不要把 `COALESCE(cost,0)` 留着）。
2. **审计失败必须显形**：所有 governance auditor 的 catch 从 `log.warn` 改为**返回 degraded 结果 + 写 `governance_jobs.result_summary_json.degraded=[...]`**；日报把"任一 auditor degraded"计入异常（否则就会重现 10-03→10-08 的静默失明）。
3. **日报口径修正**：`tools/los-governance-daily.sh` 把 **circuit open 的定时任务计入第 1 节异常**（当前 `surge log error analysis v4` 就是漏报样本）。
4. **退役僵尸**：2 条 `retired` 的 dead_letter governance job 行清理（先确认无引用）。

**验收**：`performance_audit` 的 `providerStats` 非空、`totalProviderCalls > 0`；注入一个错误列名 → 日报出现 degraded 异常（负向控制）；circuit open 的任务出现在日报第 1 节。

---

## 4. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 给 `task_runs`/`run_specs` 加列触发迁移漂移门 | 走 `pnpm check:migration-drift` + 基线；迁移在 gateway/executor 启动时 `migrateDir()` 应用 |
| 批量 supersede 150 条历史 `created` 误伤活跃引用 | 先备份（CSV）+ 只读统计 + 抽样核对；候选条件包含"无活跃 task_runs"；幂等可重跑 |
| `blocked_reason` 枚举膨胀、语义重叠 | 枚举进契约 + 一个"reason 必须属于枚举"的机械校验；新增取值必须改契约（逼迫评审） |
| self-check 三态被滥用成"把失败都推给 checker_error" | 负向控制 + 日报把 `checker_error` 单列并出 todo（可见即压力） |
| 沙箱升级语义被用作放宽策略的后门 | **不自动升级**、每命令仅一次、必须显式 justification、全部写三态事件；默认宽度不变 |

---

## 5. 验收门（整批）

1. 契约先行链完整：`contracts/` 改 → 生成类型 → 实现 → `check-contracts.sh` 绿。
2. AP1/AP2/AP3 门禁全绿；**不得新增任何绕过 `transitionExecutionState()` 的写路径**（`pnpm check:bypass`）。
3. 僵尸：近 30 天新增 `created` = 0；历史归零或全有 terminal reason；清扫 job 幂等。
4. self-check：近 7 天 `Goal self-check failed` = 0；三条负向控制（真失败 / 缺证据 / 解析失败）各落到正确终态。
5. 沙箱：`deny(sandbox_policy_denied)` 与 `already_exists` 在测试里给出**不同** reason；升级只发生一次且带 justification。
6. 死信：unacked = 0；`lease_expired` 两种情形各有收敛路径。
7. 观测：`performance_audit` 非空；注入错误 → 日报 degraded 异常；circuit open 计入异常。
8. `pnpm run gate` 绿（跨包边界）。
