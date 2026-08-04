/**
 * @los/agent/todo-seeds-audit-baseline-p1 — Audit P1 governance items (2026-06-24).
 *
 * Split from todo-seeds-audit-baseline.ts to stay under 600-line gate.
 */
import type { CreateTodoInput } from './todo-types.js';

export const AUDIT_BASELINE_P1_TODO_SEED: CreateTodoInput[] = [
  // ════════════════════════════════════════════════════════════
  // P1 — 2026-06-24 Governance Audit (5 items)
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-p1-stale-detection',
    title: 'P1-N1 P0-3 Stale detection + 自动 compaction trigger',
    description:
      '实现证据衰减评分和跨 session 模式聚合。\n' +
      '当前 P0-3 被推迟到 P1：stale candidate auto-marking, cross-session pattern aggregation, evidence decay scoring。\n' +
      '来源: los-mimo-p0-evaluation-2026-06-17',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'audit-2026-06-24',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-stale-detection',
    dependsOnIds: [],
    metadata: {
      problem: 'compaction 缺乏自动触发和模式衰减',
      sourceMemory: 'los-mimo-p0-evaluation-2026-06-17',
      files: ['packages/memory/src/core/compaction.ts'],
      subtaskPlan: 'daily-gaps-2026-07-27',
      subtaskFile: 'packages/agent/src/todo-seeds-daily-gaps.ts',
    },
  },
  {
    id: 'todo-los-p1-los-ast-rules',
    title: 'P1-N2 静态分析规则收口：豁免已落地，剩余接入 CI',
    description:
      '2026-07-31 盘点后重写（原描述基于 2026-06-24 旧理解，指向已失效的 legacy 路径）：\n' +
      'AP1 已由内部规则 packages/agent/src/static-analysis/rules/projects/los/state-machine-bypass.yml 编码；\n' +
      'AP3 不适用静态规则：markSucceeded 非公共 API，execution-store.ts 在事务内强制 canMarkSucceeded 运行时 gate；\n' +
      'AP5 不适用静态规则：loadSpecsForFiles 是 agent 运行时流程规范（无生产调用点），静态 AST 无法检测 phase 前置；\n' +
      '已完成（2026-07-31）：规则系统 exclude 字段（测试文件/包级豁免）、state-machine-bypass 与 direct-infra-import 豁免、\n' +
      'los scan 接入 ci-gate.sh Phase 7（error-only 硬门槛，10/10 phases 全绿）、规则精度修复 4 条（可信度审计）。',
    kind: 'task',
    status: 'done',
    priority: 'P1',
    source: 'audit-2026-06-24',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-los-ast-rules',
    dependsOnIds: [],
    metadata: {
      problem: 'AP 反模式依赖文档记忆，无自动检测',
      solution: 'AST 规则自动化 CI 扫描',
      files: [
        'packages/agent/src/static-analysis/rules/projects/los/',
        'packages/agent/src/static-analysis/exclude 支持（types.ts/scanner.ts）',
      ],
    },
  },
  {
    id: 'todo-los-p1-context-reconstruction',
    title: 'P1-N3 MiMo P1-4 上下文重建协议',
    description:
      '实现 failed session 的完整上下文重建：从 session_events + observations 中\n' +
      '恢复最后一次有效 checkpoint 前的完整上下文，用于 handoff 到新 agent。\n' +
      '来源: los-remaining-backlog-2026-06-17',
    kind: 'task',
    status: 'done',
    priority: 'P1',
    source: 'audit-2026-06-24',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-context-reconstruction',
    dependsOnIds: [],
    metadata: {
      problem: 'session 中断后无法恢复上下文',
      sourceMemory: 'los-remaining-backlog-2026-06-17',
      files: ['packages/agent/src/session-events.ts', 'packages/agent/src/loop/compression.ts'],
      subtaskPlan: 'daily-gaps-2026-07-27',
      evidence: [
        'contracts/session-recovery.yaml v0.1.0 (checkpoint schema + recovery flow)',
        'session-recovery.ts reconstructSessionContext() + recovery checkpoints',
        'chat-service-hooks.ts onPreCompact tool-state snapshot persistence (G1)',
        'session-recovery.test.ts end-to-end fixture (intact/partial/incompatible-version)',
        'tools/smoke-interrupted-run-recovery.sh frozen smoke (G1, 2026-08-03)',
      ],
      subtaskFile: 'packages/agent/src/todo-seeds-daily-gaps.ts',
    },
  },
  {
    id: 'todo-los-p1-cbm-ab-inject',
    title: 'P1-N4 CBM Phase 2 A/B injection',
    description:
      '当 shadow 模式积累 >= 20 sessions 且成功率 >= 90% 后，启动 A/B 注入测试。\n' +
      '随机分配 session 使用 CBM 注入的 architecture context vs 不注入。\n' +
      '当前状态：shadow mode 已启用，等数据积累。\n' +
      '来源: los-cbm-integration-backlog-2026-06-19',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'audit-2026-06-24',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-cbm-ab-inject',
    dependsOnIds: ['todo-los-execution-observability-projection'],
    metadata: {
      problem: 'CBM 注入效果未经验证',
      trigger: 'shadow sessions >= 20',
      sourceMemory: 'los-cbm-integration-backlog-2026-06-19',
      files: ['packages/gateway/src/chat-cbm-inject.ts'],
      partialEvidence: 'Alternating in-memory assignment is wired, but it is not stable across processes and is not persisted with outcome evidence.',
      acceptance: [
        'assignment is deterministic per session and persisted as an event or decision record',
        'the experiment gate verifies at least 20 eligible shadow sessions before enabling injection',
        'success, latency, token, and failure outcomes can be compared by assigned cohort',
      ],
      subtaskPlan: 'daily-gaps-2026-07-27',
      subtaskFile: 'packages/agent/src/todo-seeds-daily-gaps.ts',
    },
  },
  {
    id: 'todo-los-p1-perf-metrics',
    title: 'P1-N5 接入完整 metrics',
    description:
      '接入 task_runs 延迟、tool 成功率、provider latency、cache hit rate 的\n' +
      '结构化 metrics 收集。当前 performance_audit 提供了基础统计，需要：\n' +
      '1. Prometheus metrics endpoint\n' +
      '2. Grafana dashboard 模板\n' +
      '3. 持续收集的 provider_call_telemetry 趋势分析',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'audit-2026-06-24',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-perf-metrics',
    dependsOnIds: [],
    metadata: {
      problem: '无可观测性后端，纯 PG 查询不够',
      files: ['packages/infra/src/metrics.ts', 'packages/gateway/src/routes/'],
      subtaskPlan: 'daily-gaps-2026-07-27',
      subtaskFile: 'packages/agent/src/todo-seeds-daily-gaps.ts',
    },
  },
];
