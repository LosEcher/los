/**
 * @los/agent/todo-seeds-daily-gaps-wave3 — Daily-usable agent gap Wave 3 sub-tasks (2026-07-27).
 *
 * Wave 3 sub-tasks, split from todo-seeds-daily-gaps.ts to stay under 600-line CI gate.
 *
 * Wave 3: architect-editor (5), perf-metrics (4), cbm-ab-inject (4)
 */
import type { CreateTodoInput } from './todo-types.js';

export const DAILY_GAP_WAVE3_TODO_SEED: CreateTodoInput[] = [
  // ════════════════════════════════════════════════════════════
  // Wave 3 — architect-editor (5 sub-tasks)
  // parent: todo-los-architect-editor-separation
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-gap-ae-mode',
    title: '新增 run_contract mode `architect-editor` 和配对规则',
    description:
      '在 run-contract schema 中增加 mode="architect-editor"：\n' +
      '- architect provider/model 用于只读规划（产生自然语言方案）\n' +
      '- editor provider/model 用于写执行（产生编辑指令）\n' +
      '- 配对规则：architect 使用 reasoning-first 模型，editor 使用 editing-first 模型\n' +
      '- prompt 模板：architect 使用 exploration prompt，editor 使用简化 diff-only prompt',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-architect-editor-separation',
    dependsOnIds: [],
    dedupeKey: 'los:todo:gap-ae-mode',
    metadata: {
      problem: 'loop.ts 已有内联 architect 编排但缺少正式 run_contract mode 定义',
      solution: '在 contracts/run-spec.yaml 新增 mode enum 值 + 在 run-contract.ts 新增类型',
      acceptance: [
        'run_contract mode 支持 architect-editor',
        'RunContractMetadata 包含 architectEditor 配置字段',
        'contract check 通过',
      ],
      candidateFiles: ['contracts/run-spec.yaml', 'packages/agent/src/run-contract.ts'],
    },
  },
  {
    id: 'todo-los-gap-ae-architect',
    title: '完善 architect phase：提取内联编排为可测试模块',
    description:
      'loop.ts 第 128-172 行已内联 architect 编排（创建 architectProvider → runArchitectPhase → 注入计划）。\n' +
      '完善：提取为独立模块以便聚焦测试，增加 architect 失败重试逻辑，\n' +
      '增加结构化计划验证（不少于 2 条 PlanStep 才算有效计划）。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-architect-editor-separation',
    dependsOnIds: ['todo-los-gap-ae-mode'],
    dedupeKey: 'los:todo:gap-ae-architect',
    metadata: {
      problem: 'architect phase 代码 live 但内联在 loop.ts 中，缺少重试和验证逻辑',
      acceptance: [
        'architect 输出至少 2 条 PlanStep 才视为有效',
        'architect 失败时最多重试 2 次',
        'architect phase 有聚焦测试覆盖',
      ],
      candidateFiles: ['packages/agent/src/loop/architect-phase.ts'],
    },
  },
  {
    id: 'todo-los-gap-ae-editor',
    title: '完善 editor phase：简化 prompt + 模型选择',
    description:
      'setup.ts 已有 editorProvider/editorModel 配置解析（第 118-124 行）。\n' +
      '完善：editor 使用 capability-profile 选择 editing 优先模型，\n' +
      'editor prompt 简化为 diff-only 指令（"只输出编辑指令，不输出解释"），\n' +
      'editor system prompt 增加 architect plan 的前置上下文注入。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-architect-editor-separation',
    dependsOnIds: ['todo-los-gap-ae-mode'],
    dedupeKey: 'los:todo:gap-ae-editor',
    metadata: {
      problem: 'editor 配置解析已存在但简化 prompt 和 capability-profile 路由未完成',
      acceptance: [
        'editor prompt 不含解释性输出指令',
        'capability-profile 自动选择 editing 优先模型',
        'editor agent 不输出 "Sure, I will do X" 之类的叙事语句',
      ],
      candidateFiles: ['packages/agent/src/loop/setup.ts'],
    },
  },
  {
    id: 'todo-los-gap-ae-handoff',
    title: 'architect→editor handoff：结构化验证 + 消息转换',
    description:
      'architect 输出（自然语言方案描述 + 文件列表 + 验收标准）→\n' +
      'editor 输入（"The architect produced: X. Execute now. Only output edits."）\n' +
      '增加结构化验证：plan 是否包含明确的文件目标？是否有可验证的验收标准？\n' +
      '写聚焦测试覆盖 plan→handoff message 转换的正确性。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-architect-editor-separation',
    dependsOnIds: ['todo-los-gap-ae-architect', 'todo-los-gap-ae-editor'],
    dedupeKey: 'los:todo:gap-ae-handoff',
    metadata: {
      problem: 'architect plan → editor prompt 的手工转换逻辑内联在 loop.ts 中，未测试',
      acceptance: [
        'handoff 消息包含 architect plan + explicit "execute now" 指令',
        '无效 plan（空 / < 2 steps）被拦截在 handoff 前',
        'handoff 消息转换有聚焦测试覆盖',
      ],
      candidateFiles: ['packages/agent/src/loop/architect-integration.ts'],
    },
  },
  {
    id: 'todo-los-gap-ae-harness',
    title: '端到端 compat harness：真实 provider 验证 architect/editor 流程',
    description:
      '使用 compat harness 的 dry-run 和 --execute 模式：\n' +
      '1. 创建固定输入（复杂代码修改请求）\n' +
      '2. 跑 architect phase → 验证 plan 质量\n' +
      '3. 跑 editor phase → 验证 diff 输出质量\n' +
      '4. 与 baseline（单模型直接编辑）对比 success rate/latency/token cost',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-architect-editor-separation',
    dependsOnIds: ['todo-los-gap-ae-handoff'],
    dedupeKey: 'los:todo:gap-ae-harness',
    metadata: {
      problem: '没有真实 provider 的端到端 evidence，无法验证 architect/editor 是否提升质量',
      acceptance: [
        '至少 1 个 provider（deepseek）跑通完整 architect/editor 流程',
        'compat harness 记录 architect plan 和 editor diff',
        '与 baseline 对比的指标（success/latency/token）存入 run_eval',
      ],
      candidateFiles: ['packages/agent/src/loop/architect-integration.test.ts'],
    },
  },

  // ════════════════════════════════════════════════════════════
  // Wave 3 — perf-metrics (4 sub-tasks)
  // parent: todo-los-p1-perf-metrics
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-gap-pm-endpoint',
    title: 'Prometheus metrics endpoint：GET /metrics',
    description:
      '搭建 metrics 基础设施：\n' +
      '1. 添加 prom-client 依赖到 packages/infra/package.json\n' +
      '2. 创建 MetricsService（packages/infra/src/metrics.ts）：counter/gauge/histogram 注册\n' +
      '3. 创建 GET /metrics 端点（packages/gateway/src/metrics-endpoint.ts）：暴露 prometheus text format\n' +
      '初始指标：task_runs_total（by status/provider）、active_sessions、gateway_uptime_seconds',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-perf-metrics',
    dependsOnIds: [],
    dedupeKey: 'los:todo:gap-pm-endpoint',
    metadata: {
      problem: '完全没有 metrics 基础设施——零 prom-client 依赖、零 metrics 端点',
      acceptance: [
        'GET /metrics 返回 prometheus text format',
        '至少包含 task_runs_total / active_sessions / gateway_uptime_seconds',
        'metrics 端点不暴露敏感信息',
      ],
      candidateFiles: ['packages/infra/src/metrics.ts', 'packages/gateway/src/metrics-endpoint.ts'],
    },
  },
  {
    id: 'todo-los-gap-pm-instrument',
    title: '接入 loop metrics：关键路径埋点',
    description:
      '在 agent loop 的关键路径上 emit metrics：\n' +
      '1. tool-runner：tool_call_total（by toolName/status）、tool_call_duration_seconds\n' +
      '2. provider call：provider_request_total（by provider/model/status）、provider_request_duration_seconds\n' +
      '3. cache：cache_hit_total（by hit/miss）、cache_savings_tokens\n' +
      '4. session：session_duration_seconds、session_turns_total\n' +
      '使用 MetricsService 的单例模式，避免在 loop 中直接依赖 prom-client。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-perf-metrics',
    dependsOnIds: ['todo-los-gap-pm-endpoint'],
    dedupeKey: 'los:todo:gap-pm-instrument',
    metadata: {
      problem: 'loop 的关键路径完全没有 metrics 埋点——没有量化的运行数据',
      acceptance: [
        'tool call 成功率可通过 tool_call_total{toolName="X",status="success"} / total 计算',
        'provider latency 可通过 provider_request_duration_seconds histogram 查询 p50/p95/p99',
        'metrics emit 不影响 loop 主路径性能（异步 counter increment）',
      ],
      candidateFiles: [
        'packages/agent/src/loop/tool-runner.ts',
        'packages/agent/src/providers/',
      ],
    },
  },
  {
    id: 'todo-los-gap-pm-dashboard',
    title: 'Grafana dashboard JSON 模板',
    description:
      '基于已有的 performance_audit 指标和新增的 Prometheus metrics，\n' +
      '设计 Grafana dashboard JSON：\n' +
      '1. 概览行：active sessions / total task runs / success rate / avg latency\n' +
      '2. Provider 面板：per-provider latency p50/p95、request volume、error rate\n' +
      '3. Tool 面板：per-tool success rate、avg duration、top errors\n' +
      '4. Session 面板：session duration distribution、turn count distribution',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-perf-metrics',
    dependsOnIds: ['todo-los-gap-pm-endpoint'],
    dedupeKey: 'los:todo:gap-pm-dashboard',
    metadata: {
      problem: '即使 metrics 端点就绪，也没有可视化——需要 dashboard 模板',
      acceptance: [
        'dashboard JSON 可直接 import 到 Grafana',
        '四个面板组（概览/provider/tool/session）各有至少 3 个可视化',
        'dashboard 变量支持 provider 和 time range filter',
      ],
      candidateFiles: ['docs/operations/grafana-dashboard.json'],
    },
  },
  {
    id: 'todo-los-gap-pm-telemetry',
    title: '扩展 performance_audit 为连续 telemetry',
    description:
      '当前 performance_audit 是 governance job 产生了 snapshot 报告。\n' +
      '扩展为连续 telemetry：\n' +
      '1. provider_call_telemetry 不只在 audit 时取样，而是持续收集时序数据\n' +
      '2. 新增 provider_telemetry 表（或复用扩展 provider_call_events）\n' +
      '3. 趋势分析：7-day / 30-day rolling 的 provider 表现对比',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-perf-metrics',
    dependsOnIds: ['todo-los-gap-pm-instrument'],
    dedupeKey: 'los:todo:gap-pm-telemetry',
    metadata: {
      problem: 'performance_audit 只有 governance job 触发时的 snapshot——不是连续数据',
      acceptance: [
        'provider 调用每次写入时序记录',
        '7-day rolling 趋势可从 telemetry 查询',
        'performance_audit 使用 telemetry 数据而非一次性查询',
      ],
      candidateFiles: ['packages/agent/src/governance-auditors-performance.ts'],
    },
  },

  // ════════════════════════════════════════════════════════════
  // Wave 3 — cbm-ab-inject (4 sub-tasks)
  // parent: todo-los-p1-cbm-ab-inject
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-gap-cbm-persist',
    title: '持久化 CBM assignment：替代 in-memory 轮流分配',
    description:
      '当前 chat-cbm-inject.ts 使用交替 in-memory assignment（奇偶轮流）。\n' +
      '替换为持久化分配：每 session 的 injection/control 分配作为 session event 写入，\n' +
      '重启后不丢失、不重复。同时 deterministic assignment：同 session 始终同 cohort。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-cbm-ab-inject',
    dependsOnIds: [],
    dedupeKey: 'los:todo:gap-cbm-persist',
    metadata: {
      problem: 'Alternating in-memory assignment 不跨进程稳定、不持久化',
      acceptance: [
        '每 session 的 CBM cohort 分配持久化为 session event',
        '同 session 重复请求返回相同 cohort',
        '重启后已分配的 session 保持原有 cohort',
      ],
      candidateFiles: ['packages/gateway/src/chat-cbm-inject.ts'],
    },
  },
  {
    id: 'todo-los-gap-cbm-gate',
    title: 'injection gate：验证 shadow 数据达标后启用',
    description:
      '实现 injection 启用门禁：\n' +
      '1. 查询 shadow 模式下收集了多少 eligible sessions（非测试、非内部）\n' +
      '2. 计算 shadow success rate（>= 90% 才放行）\n' +
      '3. >= 20 eligible shadow sessions 才允许启用 injection\n' +
      '门禁通过后，新 session 按配置比例（默认 50/50）分配 injection/control。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-cbm-ab-inject',
    dependsOnIds: ['todo-los-gap-cbm-persist'],
    dedupeKey: 'los:todo:gap-cbm-gate',
    metadata: {
      problem: 'CBM A/B 不能在 shadow 数据不足时启用——需要显式门禁',
      acceptance: [
        'eligible shadow sessions >= 20 才启用 injection',
        'shadow success rate >= 90% 才启用 injection',
        '门禁失败时返回清晰的原因（session count / success rate 当前值）',
      ],
      candidateFiles: ['packages/gateway/src/chat-cbm-inject.ts'],
    },
  },
  {
    id: 'todo-los-gap-cbm-cohort',
    title: 'cohort comparison：injection vs control 分组对比',
    description:
      '实现 cohort 对比分析：\n' +
      '1. 按 injection/control 分组统计：success rate、avg latency、avg tokens、failure rate\n' +
      '2. 统计显著性检验（简单 t-test 或 bootstrap——不需要完整统计框架）\n' +
      '3. 对比结果写入 CBM analysis record（新的 session event 或 run_eval）',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-cbm-ab-inject',
    dependsOnIds: ['todo-los-gap-cbm-gate'],
    dedupeKey: 'los:todo:gap-cbm-cohort',
    metadata: {
      problem: 'A/B 数据收集了但无分析——需要有对比结果才能做决策',
      acceptance: [
        '至少比较 success rate + avg latency + avg tokens 三个维度',
        'injection 组至少在一项指标上显著优于 control 才能推荐启用',
        '对比结果持久化为可查询的记录',
      ],
      candidateFiles: ['packages/agent/src/'],
    },
  },
  {
    id: 'todo-los-gap-cbm-decision',
    title: '决策记录：CBM A/B 结果写入 ADR',
    description:
      '基于 cohort comparison 结果：\n' +
      '1. 如果 injection 显著优于 control → 推荐永久启用 injection，写 ADR 建议\n' +
      '2. 如果无显著差异 → 推荐降低 injection 优先级或关闭，写 ADR 建议\n' +
      '3. 如果 injection 显著较差 → 推荐立即关闭 injection，写 ADR 建议\n' +
      'ADR 包含原始数据引用、统计结果、决策建议、operator 审批位。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-cbm-ab-inject',
    dependsOnIds: ['todo-los-gap-cbm-cohort'],
    dedupeKey: 'los:todo:gap-cbm-decision',
    metadata: {
      problem: 'A/B 结果需要有形式化的决策记录——不能只靠 chat summary',
      acceptance: [
        'ADR 包含完整的原始数据引用和统计结果',
        'ADR 包含明确的推荐动作（enable/keep-shadow/disable）',
        'ADR 有 operator 审批位',
      ],
      candidateFiles: ['docs/adr/'],
    },
  },
];
