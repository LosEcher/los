/**
 * @los/agent/todo-seeds-audit-baseline-p2 — Audit P2+R research items (2026-06-21).
 *
 * Split from todo-seeds-audit-baseline.ts to stay under 400-line gate.
 */
import type { CreateTodoInput } from './todo-types.js';

export const AUDIT_BASELINE_P2_TODO_SEED: CreateTodoInput[] = [
  // ════════════════════════════════════════════════════════════
  // P2 — Planned (9 items)
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-p2-architecture-diagrams',
    title: 'P2-1 架构图自动生成（Mermaid/PlantUML）',
    description: '基于 contracts/*.yaml + server.ts route 注册 + KG → 自动生成系统拓扑图。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-architecture-diagrams', dependsOnIds: [], metadata: {},
  },
  {
    id: 'todo-los-p2-er-diagram',
    title: 'P2-2 ER 图自动生成',
    description: '基于 12 迁移 + ensure*Store() DDL → 自动生成 ER 图。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-er-diagram',
    dependsOnIds: ['todo-los-p0-db-schema-ddl'], metadata: {},
  },
  {
    id: 'todo-los-p2-sequence-diagrams',
    title: 'P2-3 Chat / Scheduler / Recovery 时序图',
    description: '三个核心链路的 mermaid 时序图（从文档化文本升级）。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-sequence-diagrams', dependsOnIds: [], metadata: {},
  },
  {
    id: 'todo-los-p2-openapi-docs',
    title: 'P2-4 OpenAPI 文档渲染（11 contracts → Swagger UI）',
    description: '11 个 contracts/*.yaml → Swagger UI / Scalar UI 渲染。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-openapi-docs', dependsOnIds: [], metadata: {},
  },
  {
    id: 'todo-los-p2-production-monitoring',
    title: 'P2-5 Prometheus metrics exporter',
    description: '接入 metrics（task_runs 延迟 / tool 成功率 / provider latency / cache hit rate）。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-production-monitoring', dependsOnIds: [], metadata: {},
  },
  {
    id: 'todo-los-p2-performance-bench',
    title: 'P2-6 Chat + Memory 并发压测',
    description: '对 POST /chat SSE 流 和 GET /memory?q=... FTS 查询做并发压测。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-performance-bench',
    dependsOnIds: ['todo-los-p1-memory-perf-baseline'], metadata: {},
  },
  {
    id: 'todo-los-p2-capacity-planning',
    title: 'P2-7 容量规划文档（DAU/QPS/RT/存储增量）',
    description: '基于生产数据估算容量增长。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-capacity-planning', dependsOnIds: [], metadata: {},
  },
  {
    id: 'todo-los-p2-ci-cd-docs',
    title: 'P2-8 CI/CD 流程文档',
    description: 'CI gate（ci-gate.sh 包含哪些检查、顺序、退出码语义）。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-ci-cd-docs', dependsOnIds: [], metadata: {},
  },
  {
    id: 'todo-los-p2-dr-docs',
    title: 'P2-9 灾备 / RTO / RPO 文档',
    description: 'PostgreSQL backup 策略 + 恢复时间估算。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-dr-docs', dependsOnIds: [], metadata: {},
  },

  // ════════════════════════════════════════════════════════════
  // R — Research items (need external info, 6 items)
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-research-db-data-scale',
    title: 'R1 采集生产 PostgreSQL 数据规模基线',
    description: '需要：pg_stat_user_tables 行数、索引大小、长事务频率。影响 P0-4/P1-6。',
    kind: 'task', status: 'backlog', priority: 'P1',
    source: 'audit-2026-06-21', stageId: 'research',
    dedupeKey: 'los:todo:research-db-data-scale', dependsOnIds: [],
    metadata: { needsExternalInfo: true, infoNeeded: 'pg_stat_user_tables + pg_size_pretty' },
  },
  {
    id: 'todo-los-research-provider-hit-rate',
    title: 'R2 采集 provider compat evidence 30 天 pass/fail 分布',
    description: '需要：provider_compat_evidence 表过去 30 天的 pass/fail 分布。影响 P1-1。',
    kind: 'task', status: 'backlog', priority: 'P1',
    source: 'audit-2026-06-21', stageId: 'research',
    dedupeKey: 'los:todo:research-provider-hit-rate', dependsOnIds: [],
    metadata: { needsExternalInfo: true, infoNeeded: 'SELECT provider, model, passed, count(*) FROM provider_compat_evidence ...' },
  },
  {
    id: 'todo-los-research-chat-volume',
    title: 'R3 采集 30 天 chat 请求量 / token 消耗分布',
    description: '需要：task_runs 或 gateway log 统计。影响 P2-5/P2-7。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'research',
    dedupeKey: 'los:todo:research-chat-volume', dependsOnIds: [],
    metadata: { needsExternalInfo: true, infoNeeded: 'task_runs 30-day count + token sums' },
  },
  {
    id: 'todo-los-research-node-topology',
    title: 'R4 采集当前多节点部署拓扑',
    description: '需要：executor_nodes 表 active node 数量 + 网络拓扑。影响 P1-9/P0-4。',
    kind: 'task', status: 'backlog', priority: 'P1',
    source: 'audit-2026-06-21', stageId: 'research',
    dedupeKey: 'los:todo:research-node-topology', dependsOnIds: [],
    metadata: { needsExternalInfo: true, infoNeeded: 'SELECT * FROM executor_nodes WHERE last_heartbeat > now() - interval 1 day' },
  },
  {
    id: 'todo-los-research-otel-config',
    title: 'R5 确认 OTel collector 配置',
    description: '需要：用户环境中的 OTEL 配置 / collector URL。影响 P1-10。',
    kind: 'task', status: 'backlog', priority: 'P1',
    source: 'audit-2026-06-21', stageId: 'research',
    dedupeKey: 'los:todo:research-otel-config', dependsOnIds: [],
    metadata: { needsExternalInfo: true, infoNeeded: 'OTEL_EXPORTER_OTLP_ENDPOINT / collector status' },
  },
  {
    id: 'todo-los-research-team-scale',
    title: 'R6 确认团队规模 / 多 reviewer 流程',
    description: '需要：git author 分布 + CODEOWNERS 状态。影响 P2-8。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-21', stageId: 'research',
    dedupeKey: 'los:todo:research-team-scale', dependsOnIds: [],
    metadata: { needsExternalInfo: true, infoNeeded: 'git shortlog -sn | head -10 + CODEOWNERS' },
  },
];
