# LOS Product Roadmap — 2026-08-16 起（双模型联合分析后的迭代路线图）

> 日期：2026-08-16
> 输入：DSH×gpt-5.6 双模型联合分析（2026-08-16，gpt-5.6 经 los 网关 openai/gpt-5.6-sol 调用，3997 tokens，自带 [E]/[I]/[U] 置信标注）
> 状态：operator 已确认方向（2026-08-16 会话）
> 追踪：`packages/agent/src/todo-seeds-roadmap-20260816.ts`（todo-seeds-roadmap-20260816）

## 1. 背景

双模型分析收敛的结论（详见会话报告）：

1. **主路径可靠性与恢复能力**是 P0：Work Item 全流程（goal→contract→plan→approve→execute→verify→jj diff review）已覆盖，缺 SLO 报表、故障注入演练、恢复证据的"可证明性"。
2. **验证独立性**是 P0：verifier 与执行者共享 provider/上下文时，"证据存在≠证据独立"；需要确定性检查→独立模型审查→执行模型自评的分层与独立性等级记录。
3. **kernel/provider 晋升经济证据**是 P1：Pi 17/17 样本量不足；晋升条件应绑定同语料任务成功率/恢复能力/成本/人工偏好，而非仅 turn 输出一致。
4. **部署收敛**是产品化前置：单一受支持路径（macOS launchd 或容器 appliance 二选一），补备份恢复演练、N-1 升级、诊断包导出。
5. **复杂度是最大风险**：需要季度复杂度预算与组件退役机制。

## 2. Operator 方向确认与修正（2026-08-16）

- 采纳上述方向，按 **模块化 + harness 思路逐步迭代**：每轮一个可验证单元，contract-first、jj 单意图 change、窄检查（`pnpm --filter <pkg> check/test`）+ 全量门禁（`pnpm check`）。
- **修正**：渠道（telegram/wechat）、记忆、评估**全部保留**，不作为"删除式复杂度收敛"对象；它们朝**付费梯度/加强方向**演进（见 R6）。复杂度预算只作用于"接口收敛与证据化"，不作用于"功能删除"。

## 3. 迭代路线图

每个迭代 = 一个可验证交付单元。验收标准均为可执行命令或可查询证据，不依赖散文承诺。

### R1（2026-08 起，已开始）：验证独立性等级（verification independence）

- 目标：verification 记录携带独立性等级，支撑"证据独立"声明。
- 改动面：`contracts/run-spec.yaml`（verifications independence 属性）→ `run-plan-types.ts`（`VerificationIndependence` 类型）→ `verification-records.ts`（表列 + CRUD）→ `run-spec-plans.ts`（创建时落值）→ 测试。
- 验收：
  - `pnpm --filter @los/agent test` 覆盖 independence 持久化与默认值；
  - `pnpm check` 通过；
  - `verification_records` 表含 `independence` 列（迁移兼容已有库）。

### R2：主路径 SLO 报表

- 目标：Work Item 主路径按 provider/kernel/任务类型输出 SLO（完成率、人工介入率、恢复成功率、重复副作用率、P50/P95 时长）。
- 改动面：`daily-agent-quality` 扩展或新投影（复用 `execution-observability` 指纹/瀑布思路），`/metrics` 或 usage 页新增维度；预注册 SLO 阈值写入契约。
- 验收：连续 7 天报表可查、字段契约化（`contracts/daily-agent-quality.yaml` 或新增 `contracts/slo.yaml`）、`pnpm check`。

### R3：故障注入恢复演练

- 目标：把"恢复证据"变成"恢复演练"：租约过期、进程终止、SSE 中断、DB 短暂不可用、executor 失联各有一类可重放证据。
- 改动面：复用 `execution-experiments`（K4）机制新增"恢复实验"类型；`docs/operations/` 记录演练 smoke。
- 验收：每类故障注入有对应 `docs/operations/` smoke 与恢复断言；无绕过 AP1/AP3。

### R4：kernel/provider 晋升经济证据

- 目标：Pi/LosKernel 与 provider 晋升绑定任务成功率/成本/人工偏好，preregistered 数值门槛。
- 改动面：`run_evals` pairwise 语料扩规模（数百次配对）、评审维度加成本与人工偏好、晋升门槛写入 ADR 0039 更新或新 ADR。
- 验收：晋升/回滚决策文档包含 preregistered 门槛与达到/未达到的证据；门槛不得事后选择。

### R5：部署收敛与备份恢复

- 目标：单一受支持路径（macOS launchd 为主承诺路径），补 N-1 升级回滚、迁移前自动备份、恢复演练、脱敏诊断包导出。
- 改动面：`tools/` 部署脚本 + `docs/operations/` runbook；`los doctor` 扩展。
- 验收：全新机器 30 分钟首跑 smoke；备份恢复演练 smoke；升级回滚 smoke。

### R6：付费梯度数据面（渠道/记忆/评估保留加强）

- 目标：为"免费个人层 + Pro"梯度准备证据面：per-feature usage 立方（渠道/记忆/评估分别计量），定价决策有数据。
- 改动面：`usage-summary` 扩展 feature 维度；`provider_call_telemetry` 增加 feature 标签（不新增表，复用现有列或轻量映射）；Web usage 页按 feature 分面。
- 验收：usage 查询可按 feature 分组；`contracts/usage-summary.yaml` 更新；`pnpm check`。

### R7：复杂度预算机制

- 目标：季度复杂度预算：新增长期组件须配对"接口收敛/证据化"动作；后台 job 数量、包依赖数、迁移频率纳入治理报表（`governance_jobs` 或 daily digest）。
- 改动面：`tools/check-structure.sh` 或新结构检查 + `periodic-analysis` 增复杂度指标。
- 验收：结构检查输出复杂度指标并纳入 `pnpm check`；daily digest 含复杂度趋势。

## 4. 实现纪律（每轮必做）

1. **contract-first**：公共 API/表结构变化先改 `contracts/`，再生成/同步类型，最后实现。
2. **jj 单意图 change**：一个 change 一个意图；`jj describe` 固化后开新 change。
3. **窄检查优先**：每步 `pnpm --filter <pkg> check` + 聚焦测试；跨包改动收尾跑 `pnpm check` / `pnpm test`（ADR 0014 门禁）。
4. **证据留痕**：每个迭代在 `docs/operations/` 留 smoke 或在 commit 描述记录验证命令与结果。
5. **gate 对齐**：触发 AP11（prompt/tool/context 策略变化）时走 `docs/governance/code-first-determinism.md` 清单。

## 5. 关联文档

- `docs/research/2026-08-16-observability-comparison-dsh.md`（los×DSH 对比基线）
- `docs/adr/0038-web-first-daily-coding-agent-product-boundary.md`（产品边界）
- `docs/adr/0039-pluggable-execution-kernel-and-pi-adoption.md`（内核可插拔与晋升门）
- `docs/adr/0040-execution-experiment-provenance-and-candidate-lifecycle.md`（实验证据）
- `docs/governance/agent-workflow-roadmap.md`（Stage 级路线图，本文档是其迭代细化）
