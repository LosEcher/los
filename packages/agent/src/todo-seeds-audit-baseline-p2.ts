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

  // ════════════════════════════════════════════════════════════
  // P2 — 2026-06-24 Governance Audit (8 items)
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-p2-index-health',
    title: 'P2-N1 Index health governance job',
    description:
      '新建 index_health 审计，查询 pg_stat_user_indexes 分析：\n' +
      '1. 未使用的索引（idx_scan = 0）\n' +
      '2. 索引膨胀率\n' +
      '3. 缺失索引建议（基于 seq_scan 高频表）',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-24', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-index-health', dependsOnIds: [],
    metadata: {
      files: ['packages/agent/src/governance-auditors-performance.ts'],
      needsProductionData: true,
    },
  },
  {
    id: 'todo-los-p2-live-runtime-truth',
    title: 'P2-N2 Live runtime truth gate',
    description:
      '比对运行时配置 vs 声明配置：\n' +
      '1. gateway health vs SERVER_PORT/SERVER_HOST 声明\n' +
      '2. executor registry vs executor_nodes 表\n' +
      '3. PG NOTIFY listener vs session_events channel\n' +
      '参考 lsclaw 的 check:live-runtime 模式。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-24', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-live-runtime-truth', dependsOnIds: [],
    metadata: {
      sourceProject: 'lsclaw',
      sourceScript: 'check:live-runtime',
      files: ['tools/check-live-runtime.sh'],
    },
  },
  {
    id: 'todo-los-p2-code-quality-governance',
    title: 'P2-N3 Code quality governance — forbidden pattern CI',
    description:
      '移植 lsclaw 的 --governance-only forbidden pattern 检测：\n' +
      '1. 禁止 getRunCached 代替 getRunFresh\n' +
      '2. 禁止非 execution-store 文件直接调用 transitionExecutionState\n' +
      '3. 禁止非 gateway 文件引用 Fastify 实例\n' +
      '4. 自动化扫描替代当前手动 AGENTS.md 文档约定。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-24', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-code-quality-governance', dependsOnIds: ['todo-los-p1-los-ast-rules'],
    metadata: {
      sourceProject: 'lsclaw',
      sourceScript: 'check-code-quality.mjs',
      files: ['tools/check-code-quality.sh'],
    },
  },
  {
    id: 'todo-los-p2-dep-freshness',
    title: 'P2-N4 Dependency freshness 监控',
    description:
      '检测超过 N 个月未更新的依赖，识别 abandonware 风险：\n' +
      '1. npm view <pkg> time 检查 last publish date\n' +
      '2. 标记超过 18 个月未发布的包\n' +
      '3. 集成到 supply_chain_audit 结果中',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-24', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-dep-freshness', dependsOnIds: ['todo-los-p1-supply-chain-full'],
    metadata: {
      files: ['packages/agent/src/governance-auditors-supply-chain.ts'],
    },
  },
  {
    id: 'todo-los-p2-cross-job-learning',
    title: 'P2-N5 跨 job 模式学习',
    description:
      '扩展 ga-self-improve.ts 支持跨多个 job 的模式分析：\n' +
      '1. 关联多个 job type 的 findings\n' +
      '2. 检测跨 job 的重复 escalation pattern\n' +
      '3. 建议合并/拆分 job type',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-24', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-cross-job-learning', dependsOnIds: [],
    metadata: {
      files: ['packages/agent/src/ga-self-improve.ts'],
    },
  },
  {
    id: 'todo-los-p2-auto-candidate-promotion',
    title: 'P2-N6 Procedural candidate 自动晋升',
    description:
      '当 procedural_candidate 满足条件时自动从 approved→active：\n' +
      '1. 置信度 >= 阈值（如 0.8）\n' +
      '2. 跨 >= 3 sessions 验证\n' +
      '3. 无 operator 驳回记录\n' +
      '当前 lifecycle 完全手动，需要 operator gate 但可自动化常规晋升。',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-24', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-auto-candidate-promotion', dependsOnIds: ['todo-los-p2-cross-job-learning'],
    metadata: {
      files: ['packages/memory/src/core/compaction.ts'],
    },
  },
  {
    id: 'todo-los-p2-db-migration-drift',
    title: 'P2-N7 Migration drift 检测',
    description:
      '比对 schema_migrations 表 vs information_schema 的实际 schema：\n' +
      '1. 检测手写 SQL 添加的列\n' +
      '2. 检测 migration 文件中声明但未实际创建的表\n' +
      '3. 检测 migration version 顺序冲突',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-24', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-db-migration-drift', dependsOnIds: ['todo-los-p0-schema-consistency'],
    metadata: {
      files: ['packages/infra/src/migrate.ts', 'packages/infra/migrations/'],
    },
  },
  {
    id: 'todo-los-p2-ddl-linting',
    title: 'P2-N8 DDL linting 集成',
    description:
      '集成 pg-lint 或 squawk 到 CI pipeline：\n' +
      '1. 检测 migration 中的 table lock 风险\n' +
      '2. 检测缺失的 CONCURRENTLY 索引创建\n' +
      '3. 检测缺失的事务边界',
    kind: 'task', status: 'backlog', priority: 'P2',
    source: 'audit-2026-06-24', stageId: 'p2-planned',
    dedupeKey: 'los:todo:p2-ddl-linting', dependsOnIds: ['todo-los-p2-db-migration-drift'],
    metadata: {
      files: ['packages/infra/migrations/', 'tools/check-ddl.sh'],
    },
  },
];
