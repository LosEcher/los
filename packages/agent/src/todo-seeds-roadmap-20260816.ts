import type { CreateTodoInput } from './todo-types.js';

/**
 * 2026-08-16 产品路线图批次（DSH×gpt-5.6 双模型联合分析后确认）。
 * 文档：docs/governance/2026-08-16-product-roadmap.md
 * 来源：product-roadmap-2026-08-16
 */
export const PRODUCT_ROADMAP_20260816_TODO_SEED: CreateTodoInput[] = [
  {
    id: 'todo-los-rm-verification-independence',
    title: 'R1: 验证独立性等级（verification independence）——验证记录携带 independence 字段',
    description:
      'verification 记录与 VerificationRequirement 增加独立性等级字段 ' +
      '(deterministic | separate_model | same_model | unknown，默认 unknown)：' +
      'contracts/run-spec.yaml verifications items 加 independence 属性 → run-plan-types.ts 类型 → ' +
      'verification-records.ts 表列(ALTER TABLE IF NOT EXISTS 兼容) + CRUD → run-spec-plans.ts 创建时落值 → 测试。',
    kind: 'task',
    status: 'in_progress',
    priority: 'P0',
    source: 'product-roadmap-2026-08-16',
    stageId: 'roadmap-q1',
    dedupeKey: 'los:todo:rm-verification-independence',
    metadata: {
      problem: 'verifier 与执行者共享 provider/上下文时，"证据存在≠证据独立"；验证记录无独立性等级，质量面板无法区分确定性检查/独立模型审查/自评。',
      solution: 'VerificationRequirement.independence 四值枚举 + verification_records.independence 列，创建时从 requirement 落值，未知默认 unknown 显式呈现。',
      evidence: [
        'packages/agent/src/verification-records.ts VerificationRecord 接口',
        'packages/agent/src/run-plan-types.ts VerificationRequirement',
        'contracts/run-spec.yaml verifications items',
      ],
      validation: [
        'pnpm --filter @los/agent test 覆盖 independence 持久化与默认值',
        'pnpm check 通过',
        'verification_records 表含 independence 列且已有库兼容',
      ],
      referenceReport: 'docs/governance/2026-08-16-product-roadmap.md R1',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-rm-slo-report',
    title: 'R2: 主路径 SLO 报表——Work Item 流程按 provider/kernel/任务类型输出 SLO',
    description:
      '复用 execution-observability 指纹/瀑布思路，扩展 daily-agent-quality 或新增投影：' +
      '完成率、人工介入率、恢复成功率、重复副作用率、P50/P95 时长，按 provider/kernel/任务类型分维度；' +
      '预注册 SLO 阈值写入契约（contracts/slo.yaml 或扩展 daily-agent-quality.yaml）。',
    kind: 'task',
    status: 'ready',
    priority: 'P0',
    source: 'product-roadmap-2026-08-16',
    stageId: 'roadmap-q1',
    dependsOnIds: ['todo-los-rm-verification-independence'],
    dedupeKey: 'los:todo:rm-slo-report',
    metadata: {
      problem: '主路径无 SLO 报表：恢复机制存在但"恢复证据"未变成"恢复证明"；跨 provider/kernel 分维度缺失。',
      solution: 'SLO 投影 + 契约化阈值 + /metrics 或 usage 页新维度；验收=连续 7 天报表可查。',
      evidence: ['packages/agent/src/execution-observability.ts', 'packages/agent/src/daily-agent-quality'],
      validation: ['连续 7 天报表可查', '字段契约化', 'pnpm check'],
      referenceReport: 'docs/governance/2026-08-16-product-roadmap.md R2',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-rm-fault-injection',
    title: 'R3: 故障注入恢复演练——租约过期/进程终止/SSE 中断/DB 不可用/executor 失联各一类可重放证据',
    description:
      '复用 execution-experiments(K4) 机制新增"恢复实验"类型；每类故障注入对应 docs/operations/ smoke 与恢复断言；' +
      '不得绕过 AP1(transitionExecutionState)/AP3(canMarkSucceeded)。',
    kind: 'task',
    status: 'ready',
    priority: 'P0',
    source: 'product-roadmap-2026-08-16',
    stageId: 'roadmap-q1',
    dependsOnIds: ['todo-los-rm-slo-report'],
    dedupeKey: 'los:todo:rm-fault-injection',
    metadata: {
      problem: '恢复机制（run-resume-recovery/execution-lease-reaper/dual-lease-fencing）存在但无演练证据。',
      solution: 'K4 机制扩展恢复实验类型，docs/operations/ 留 smoke。',
      evidence: ['packages/gateway/src/run-resume-recovery.ts', 'packages/gateway/src/execution-lease-reaper.ts'],
      validation: ['每类故障有对应 smoke 与恢复断言', 'pnpm check'],
      referenceReport: 'docs/governance/2026-08-16-product-roadmap.md R3',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-rm-kernel-economics',
    title: 'R4: kernel/provider 晋升经济证据——Pi/LosKernel 晋升绑定成功率/成本/人工偏好',
    description:
      'run_evals pairwise 语料扩规模（数百次配对运行，相同 RunContract/ToolBroker/verifier）；' +
      '评审维度加成本与人工偏好；preregistered 数值门槛写入 ADR 0039 更新或新 ADR；门槛不得事后选择。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'product-roadmap-2026-08-16',
    stageId: 'roadmap-q1',
    dedupeKey: 'los:todo:rm-kernel-economics',
    metadata: {
      problem: 'Pi 17/17 样本量不足以支持默认替换；晋升只比较 turn 输出，未绑定成功率/成本/人工偏好。',
      solution: '规模化配对运行 + 评审维度扩展 + preregistered 门槛。',
      evidence: ['packages/agent/src/execution-experiments.ts', 'contracts/execution-pairwise-eval.yaml'],
      validation: ['晋升/回滚文档含 preregistered 门槛与证据', 'pnpm check'],
      referenceReport: 'docs/governance/2026-08-16-product-roadmap.md R4',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-rm-deploy-converge',
    title: 'R5: 部署收敛——单一受支持路径 + 备份恢复演练 + N-1 升级回滚 + 脱敏诊断包',
    description:
      'macOS launchd 为主承诺路径（docker 为备选文档化路径）：tools/ 部署脚本 + docs/operations/ runbook；' +
      'los doctor 扩展；验收=全新机器 30 分钟首跑 smoke、备份恢复 smoke、升级回滚 smoke。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'product-roadmap-2026-08-16',
    stageId: 'roadmap-q2',
    dedupeKey: 'los:todo:rm-deploy-converge',
    metadata: {
      problem: 'launchd 与 docker 双承诺路径；无升级回滚/备份恢复演练；诊断依赖人工抓日志。',
      solution: '主承诺路径 + 演练 smoke + doctor 扩展。',
      evidence: ['tools/los-launchd-wrapper.sh', 'docs/operations/rollout-runbook.md'],
      validation: ['三个 smoke 落 docs/operations/', 'pnpm check'],
      referenceReport: 'docs/governance/2026-08-16-product-roadmap.md R5',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-rm-paid-tier-evidence',
    title: 'R6: 付费梯度数据面——渠道/记忆/评估保留并加强，per-feature usage 立方',
    description:
      'usage-summary 扩展 feature 维度（channel/memory/eval 分别计量）；provider_call_telemetry 增加 feature 标签（复用现有列或轻量映射，不新增表）；' +
      'Web usage 页按 feature 分面；contracts/usage-summary.yaml 更新。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'product-roadmap-2026-08-16',
    stageId: 'roadmap-q2',
    dedupeKey: 'los:todo:rm-paid-tier-evidence',
    metadata: {
      problem: '付费梯度决策无数据：渠道/记忆/评估的用量与成本混在整体 usage 里，无法支撑 Pro 分层定价。',
      solution: 'per-feature usage 立方，定价决策有数据；功能保留不做删除式收敛。',
      evidence: ['packages/agent/src/usage-summary.ts', 'contracts/usage-summary.yaml'],
      validation: ['usage 查询可按 feature 分组', 'pnpm check'],
      referenceReport: 'docs/governance/2026-08-16-product-roadmap.md R6',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-rm-complexity-budget',
    title: 'R7: 复杂度预算机制——新增长期组件须配对收敛动作，复杂度指标入治理报表',
    description:
      'tools/check-structure.sh 或新结构检查输出复杂度指标（后台 job 数/包依赖数/迁移频率），纳入 pnpm check 与 daily digest；' +
      '渠道/记忆/评估不在删除范围，预算只作用于接口收敛与证据化。',
    kind: 'task',
    status: 'backlog',
    priority: 'P2',
    source: 'product-roadmap-2026-08-16',
    stageId: 'roadmap-q2',
    dedupeKey: 'los:todo:rm-complexity-budget',
    metadata: {
      problem: '功能浪潮密集（2026-08 连续功能合并），无组件退役/收敛机制，复杂度趋势不可见。',
      solution: '复杂度指标机械输出 + 治理报表呈现。',
      evidence: ['tools/check-structure.sh', 'docs/governance/periodic-analysis.md'],
      validation: ['pnpm check 输出复杂度指标', 'daily digest 含复杂度趋势'],
      referenceReport: 'docs/governance/2026-08-16-product-roadmap.md R7',
      statusUpdatedAt: '2026-08-16',
    },
  },
];
