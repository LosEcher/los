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
      'verification-records.ts 表列(ALTER TABLE IF NOT EXISTS 兼容) + CRUD → run-spec-plans.ts 创建时落值 → 测试。' +
      '含 056 迁移对齐（check-migration-drift 清零）。',
    kind: 'task',
    status: 'done',
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
        'packages/infra/migrations/056_verification_records_independence.sql',
      ],
      validation: [
        'pnpm --filter @los/agent test 覆盖 independence 持久化与默认值',
        'pnpm check 通过',
        'verification_records 表含 independence 列且已有库兼容',
        'check-migration-drift 无新增漂移',
      ],
      referenceReport: 'docs/governance/2026-08-16-product-roadmap.md R1',
      implementedAt: '2026-08-16',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-rm-slo-report',
    title: 'R2: 主路径 SLO 报表——task_runs 按 provider/model/kernel 输出完成率/介入率/恢复率/延迟（已完成）',
    description:
      '新增 contracts/slo.yaml 契约 + packages/agent/src/slo-report.ts 投影（task_runs 聚合：' +
      'completionRate/interventionRate/recoveryRate/p50/p95，按 provider×model×executionKernel 分组）+ ' +
      'GET /slo/report 路由 + 测试；R2a 采集加强：provider_call_telemetry 增加 request_meta_json ' +
      '（reasoningEffort/thinking/maxTokens/temperature，对齐 DSH LlmCallConfig，055 迁移），' +
      'providers/index.ts 4 处 chat 调用点落值。指标为显式代理语义（blocked≈等 operator）。',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'product-roadmap-2026-08-16',
    stageId: 'roadmap-q1',
    dependsOnIds: ['todo-los-rm-verification-independence'],
    dedupeKey: 'los:todo:rm-slo-report',
    metadata: {
      problem: '主路径无 SLO 报表：恢复机制存在但"恢复证据"未变成"恢复证明"；跨 provider/kernel 分维度缺失；effort 无采集无法回测推理档位影响。',
      solution: 'SLO 投影（代理指标显式化）+ 契约化 + /slo/report 路由；request_meta_json 采集请求配置。',
      evidence: [
        'packages/agent/src/slo-report.ts',
        'contracts/slo.yaml',
        'packages/gateway/src/routes/data/slo-routes.ts',
        'packages/agent/src/providers/telemetry.ts requestMeta',
        'packages/infra/migrations/055_provider_call_request_meta.sql',
      ],
      validation: [
        '真实数据报表可查（2026-08-16 实测 30 天 26 组：pi canary 75% 介入率、packycode 0% 完成率）',
        '字段契约化（check-contracts passed）',
        'pnpm check 通过；agent 全量测试 394/394',
        'check-migration-drift 无新增漂移',
      ],
      referenceReport: 'docs/governance/2026-08-16-product-roadmap.md R2',
      implementedAt: '2026-08-16',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-rm-fault-injection',
    title: 'R3: 故障注入恢复演练——租约过期/进程终止/SSE 中断/DB 不可用/executor 失联各一类可重放证据（已完成）',
    description:
      '复用 execution-experiments(K4) 机制新增"恢复实验"类型；每类故障注入对应 docs/operations/ smoke 与恢复断言；' +
      '不得绕过 AP1(transitionExecutionState)/AP3(canMarkSucceeded)。',
    kind: 'task',
    status: 'done',
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
    title: 'R4: kernel/provider 晋升经济证据——ADR 0041 preregistered 门槛已定，观察期进行中（2026-09-16 检查点）',
    description:
      'run_evals pairwise 语料扩规模（数百次配对运行，相同 RunContract/ToolBroker/verifier）；' +
      '评审维度加成本与人工偏好；preregistered 数值门槛写入 ADR 0039 更新或新 ADR；门槛不得事后选择。' +
      '机制部分已完成（ADR 0041：证据维度/样本门/非劣性阈值/决策规则/节奏），' +
      '晋升决策等待观察期数据（pairwise ≥50 组、effort ≥30 天、样本各 ≥30，2026-09-16 检查）。',
    kind: 'task',
    status: 'in_progress',
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
    title: 'R5: 部署收敛——launchd 主承诺路径 + 备份恢复演练 + 升级回滚（已完成）',
    description:
      'macOS launchd 为主承诺路径（docker 为备选文档化路径）：tools/ 部署脚本 + docs/operations/ runbook；' +
      'los doctor 扩展；验收=全新机器 30 分钟首跑 smoke、备份恢复 smoke、升级回滚 smoke。' +
      '已完成：tools/db-backup.sh（14 份保留）+ 备份恢复演练实测（22MB dump→临时库行数全等→清理）+ ' +
      'docs/operations/2026-08-16-deployment-convergence.md（主路径声明+证据+9-16 检查点 SQL）。',
    kind: 'task',
    status: 'done',
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
    title: 'R6: 付费梯度数据面——per-feature usage 立方（已完成）',
    description:
      'usage-summary 扩展 feature 维度（channel/memory/eval 分别计量）；provider_call_telemetry 增加 feature 标签（复用现有列或轻量映射，不新增表）；' +
      'Web usage 页按 feature 分面；contracts/usage-summary.yaml 更新。',
    kind: 'task',
    status: 'done',
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
