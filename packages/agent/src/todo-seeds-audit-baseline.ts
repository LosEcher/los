/**
 * @los/agent/todo-seeds-audit-baseline — Audit findings from 2026-06-21 project context baseline.
 *
 * P0-P2 findings + R1-R6 research items sourced from:
 *   docs/architecture/2026-06-21-audit-findings-and-optimization-plan.md
 *   docs/architecture/2026-06-21-project-context-baseline.md
 *
 * Structure: each todo follows the existing seed convention:
 *   id / title / description / kind / status / priority / source / stageId / dedupeKey / dependsOnIds / metadata
 */
import type { CreateTodoInput } from './todo-types.js';

export const AUDIT_BASELINE_TODO_SEED: CreateTodoInput[] = [
  // ════════════════════════════════════════════════════════════
  // P0 — Immediate Fixes (8 items)
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-p0-file-size-gate',
    title: 'P0-1 升级文件大小门禁：新文件 >400 行 block',
    description:
      '当前 check-structure.sh BLOCK_LINES=400 但新文件超 400 行仅 warn 而非 error。28 个源文件超 400 行。\n' +
      '修复：新文件（不在 grandfathered baseline）超 400 行改为 error；建立 grandfathered baseline 清单声明 owner + 拆解计划。\n' +
      '来源：docs/architecture/2026-06-21-audit-findings-and-optimization-plan.md §P0-1',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'audit-2026-06-21',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-file-size-gate',
    dependsOnIds: [],
    metadata: {
      problem: 'AGENTS.md:16 声明的门禁（>400 warn, >600 block）部分失效',
      solution: '收紧新文件 warn→error + 创建 grandfathered baseline',
      files: ['tools/check-structure.sh', 'tools/.large-file-baseline.txt'],
      validation: 'pnpm check 新文件 >400 行报 error',
      evidence: ['commit 5fc50495d0eb', 'tools/check-structure.sh blocks non-baseline files over 400 lines'],
      statusUpdatedAt: '2026-07-15',
    },
  },

  {
    id: 'todo-los-p0-db-schema-ddl',
    title: 'P0-2 补全 DB schema DDL（15+ 缺失表 → 迁移文件）',
    description:
      '仅 12 个迁移文件覆盖了部分表。代码中至少 15+ 张表（run_specs/tool_call_states/verification_records/executor_nodes/\n' +
      'service_instances/idempotency_keys/todos/skills/rules/mcp_servers/artifacts/provider_compat_evidence/\n' +
      'run_evals/stream_checkpoints/observations/memory_compactions/agent_tasks + attempts + edges）\n' +
      '仅在 ensure*Store() 中以 CREATE TABLE IF NOT EXISTS 定义，无独立迁移记录。\n' +
      '修复：为每张缺失表写迁移文件（013_xxx.sql 起）；ensure*Store() 中 DDL 移入迁移。',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'audit-2026-06-21',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-db-schema-ddl',
    dependsOnIds: [],
    metadata: {
      problem: '双 DDL 路径导致生产 schema 与迁移历史不一致',
      solution: '全部 DDL 收敛到 migrations/；加 tools/check-migrations.sh',
      validation: 'migration drift gate passes with an empty committed baseline',
      evidence: ['migrations 013-021 cover the audited missing-table scope', 'tools/migration-drift-baseline.txt has 0 drift entries'],
      successor: 'Runtime ensure-store DDL removal remains lower-priority schema single-source cleanup.',
      statusUpdatedAt: '2026-07-15',
    },
  },

  {
    id: 'todo-los-p0-unwired-exports-ci',
    title: 'P0-3 "Implemented But Not Wired" CI gate',
    description:
      '7 天 6 次出现 implemented-but-not-wired 反模式，当前仅靠人工审查。\n' +
      '修复：扩展 check-unwired-exports.sh 检测规则（无 caller export / route 未注册 / CLI 命令未挂接）；\n' +
      '加入 pnpm check pipeline。',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'audit-2026-06-21',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-unwired-exports-ci',
    dependsOnIds: ['todo-los-p0-db-schema-ddl'],
    metadata: {
      problem: '已完成功能未接线，幻觉式"完成"持续产生',
      solution: '扩展 check-unwired-exports.sh + CI integration',
      files: ['tools/check-unwired-exports.sh'],
      validation: 'pnpm check 在发现 unwired export 时 report error',
      evidence: ['commits a07f81774317 and 44a773120ab2', 'pnpm check runs unwired export and wiring topology gates'],
      statusUpdatedAt: '2026-07-15',
    },
  },

  {
    id: 'todo-los-p0-memory-production',
    title: 'P0-4 Memory module production wiring',
    description:
      'Memory 子系统当前 381 条 observations 全为测试数据，maxObservations 未强制，\n' +
      'retention/integrity 仅靠 24h 自动定时器，procedural_candidates 从未生成。\n' +
      '修复：chat 完成后自动抽取 observation；enforce maxObservations；\n' +
      '确保 compactSession 后 procedural_candidates 自动种子。',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'audit-2026-06-21',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-memory-production',
    dependsOnIds: ['todo-los-p0-db-schema-ddl'],
    metadata: {
      problem: '核心差异化能力空转，不在生产路径上运行',
      solution: 'chat-complete hook → observation extraction + maxObservations enforce',
      files: ['packages/gateway/src/chat-memory-augment.ts', 'packages/memory/src/core/store.ts'],
      validation: '单次 chat 后 SELECT count(*) FROM observations > 0',
      evidence: ['chat-route enables persistence by default', 'store.ts enforces maxObservations', '2026-07-15 live DB: observations=1, procedural_candidates=31, memory_compactions=154'],
      statusUpdatedAt: '2026-07-15',
    },
  },

  {
    id: 'todo-los-p0-governance-sweeper',
    title: 'P0-5 Governance periodic sweeper schedule + seed jobs',
    description:
      'Governance module 有 drift_sweeper / periodic_sweeper / hotspot_and_tool_drift 三个 backlog job，\n' +
      '但 5 个 governance category 无一有 seed job 或 schedule 运行。\n' +
      '修复：完成 periodic_sweeper 实现；为 5 个 category 创建 seed jobs；\n' +
      '确认 server-maintenance.ts 的 governance sweep 定时器调用了 drift sweeper。',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'audit-2026-06-21',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-governance-sweeper',
    dependsOnIds: ['todo-los-p0-db-schema-ddl'],
    metadata: {
      problem: '治理闭环断开 — 3 个 job backlog，无 schedule',
      solution: 'periodic_sweeper implementation + seed jobs + server-maintenance wiring',
      files: ['packages/agent/src/governance-sweeper.ts', 'packages/agent/src/governance-jobs.ts', 'packages/gateway/src/server-maintenance.ts'],
      validation: 'SELECT job_type, last_run_at FROM governance_jobs 显示所有活跃 job 有最近执行',
      evidence: ['commit 44a773120ab2', 'server maintenance seeds jobs and starts the PG queue wake loop', '2026-07-15 live DB contains 15 scheduled governance jobs'],
      statusUpdatedAt: '2026-07-15',
    },
  },

  {
    id: 'todo-los-p0-eval-probes',
    title: 'P0-6 Eval probes 扩展至 ≥8 个自动化 case',
    description:
      '20 个 eval cases (E01-E20)，但 eval-probes.test.ts 仅覆盖 E02/E03/E08。\n' +
      '按 promotion order 优先写 E01(dirty worktree)+E06(todo done without evidence)+E07(legacy as active target)。\n' +
      'E14/E15/E16 已有 run-contract.test.ts 覆盖，确认标记 hasProbe:true。',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'audit-2026-06-21',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-eval-probes',
    dependsOnIds: [],
    metadata: {
      problem: '防漂移机制无牙 — 17/20 eval cases 无自动回归',
      solution: 'E01+E06+E07 写 probe + E14/15/16 标记 hasProbe',
      files: ['packages/agent/src/eval-probes.test.ts', 'packages/agent/src/eval-backlog-runner.ts'],
      validation: 'node --test packages/agent/src/eval-probes.test.ts 覆盖 >= 8 cases',
      targetProbes: ['E01', 'E02', 'E03', 'E06', 'E07', 'E08', 'E14', 'E15', 'E16'],
      evidence: ['eval-backlog-runner marks 11 cases with automated probes', 'E01/E02/E03/E05/E06/E07/E08 have focused probe tests'],
      statusUpdatedAt: '2026-07-15',
    },
  },

  {
    id: 'todo-los-p0-ap6-child-contract',
    title: 'P0-7 AP6 修复：child agent run contract 完整继承',
    description:
      'spawn_agent 工具创建子 agent 时，run contract 传播是 "basic"（ADR 0021）。\n' +
      '子 agent 无 phase 约束、可 succeeded 无 verification（Fleet Loop invariant 破损）。\n' +
      '修复：spawn_agent 中完整传播 parent runContract；子 agent 检查 inherited contract；\n' +
      '添加 child_run_spec_id + parent_run_spec_id 外键。',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'audit-2026-06-21',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-ap6-child-contract',
    dependsOnIds: ['todo-los-p0-db-schema-ddl'],
    metadata: {
      problem: '子 agent 无 phase 约束，可绕过 B0 gate',
      solution: '完整继承 parent runContract + child lineage tracking',
      files: ['packages/agent/src/tools/agent-tools.ts', 'packages/agent/src/run-contract.ts'],
      validation: 'spawn_agent 单元测试覆盖 planParentRunSpecId 非空',
      evidence: ['commits 44a773120ab2 and d5f2d8bc01d0', 'spawn_agent child inherits isolated run contract metadata'],
      statusUpdatedAt: '2026-07-15',
    },
  },

  {
    id: 'todo-los-p0-mcp-connection-leak',
    title: 'P0-8 MCP 连接生命周期 audit 与防泄漏',
    description:
      'MCPStdioTransport.close fan-in = 27。高 fan-in + stdio 子进程管理不一致可能留下僵尸进程。\n' +
      '修复：review tools/external/mcp-client.ts 生命周期；确保 mcpCleanup 覆盖所有 transport；\n' +
      'gateway 启动/关闭时添加 MCP 子进程健康检查。',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'audit-2026-06-21',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-mcp-connection-leak',
    dependsOnIds: [],
    metadata: {
      problem: '30min gateway 运行可能留下僵尸 MCP stdio 进程',
      solution: 'review lifecycle + add health check',
      files: ['packages/agent/src/tools/external/mcp-client.ts', 'packages/agent/src/loop.ts'],
      validation: 'gateway 运行 30min 后 ps aux | grep mcp 无泄露子进程',
      evidence: ['loop.ts always awaits mcpCleanup()', 'MCPClientManager.close() settles every client close', '2026-07-15 gateway uptime exceeded 48h with no MCP or zombie child process'],
      statusUpdatedAt: '2026-07-15',
    },
  },

  // ════════════════════════════════════════════════════════════
  // P1 — This Iteration (12 items)
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-p1-provider-promotion-docs',
    title: 'P1-1 Provider promotion decision matrix 文档 + 测试',
    description:
      'ADR 0017 定义了 3 种 target state 但未定义 automated promotion 条件。\n' +
      '需要：补充判定矩阵 + 为 recordProviderPromotionDecision 添加单元测试。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-provider-promotion-docs',
    dependsOnIds: [],
    metadata: { files: ['packages/agent/src/provider-promotion-decisions.ts', 'docs/adr/0017-advisory-provider-promotion-playbook.md'] },
  },

  {
    id: 'todo-los-p1-tool-recovery-matrix',
    title: 'P1-2 Tool-call recovery 完整矩阵测试（5 actions × 4 entities）',
    description: 'tool-call-recovery.ts 处理 5 种 action 但无完整测试。需要覆盖 retry/resume/cancel/operator_attention/terminal_failed × 4 entity 类型。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-tool-recovery-matrix',
    dependsOnIds: [],
    metadata: { files: ['packages/agent/src/tool-call-recovery.ts', 'packages/agent/src/tool-call-recovery.test.ts'] },
  },

  {
    id: 'todo-los-p1-provider-policy-unify',
    title: 'P1-3 统一 provider selection 入口（chat + scheduler 走同一条路径）',
    description: 'gateway chat (setup.ts) 与 scheduler graph (scheduler.ts) 的 provider 选择走不同路径，可能导致同一 task 选不同 provider。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-provider-policy-unify',
    dependsOnIds: ['todo-los-p1-provider-promotion-docs'],
    metadata: { files: ['packages/agent/src/loop/setup.ts', 'packages/agent/src/scheduler/provider-selection.ts'] },
  },

  {
    id: 'todo-los-p1-identity-consistency',
    title: 'P1-4 Identity injection 6 路径一致性验证',
    description: 'ADR 0023 定义了 6 条路径各不同的 identity level。resolveAgentIdentity() 实现需验证覆盖所有 6 条路径，包括 scheduler verifier 必须是 none。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-identity-consistency',
    dependsOnIds: [],
    metadata: { files: ['packages/agent/src/identity-loader.ts', 'docs/adr/0023-agent-identity-decision-framework.md'] },
  },

  {
    id: 'todo-los-p1-memory-perf-baseline',
    title: 'P1-6 Memory FTS EXPLAIN ANALYZE + 性能 baseline + 回归断言',
    description: 'memory/core/store.ts 600 行 FTS 实现无性能基线。需要在 1000/10000/100000 行 observations 规模下 EXPLAIN ANALYZE。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-memory-perf-baseline',
    dependsOnIds: ['todo-los-p0-memory-production'],
    metadata: { files: ['packages/memory/src/core/store.ts'] },
  },

  {
    id: 'todo-los-p1-bot-production',
    title: 'P1-7 WeChat/Telegram bot 生产就绪（health/retry/docs）',
    description: '两个 bot 均为独立进程，失败模式无文档。需要：health endpoint、重连/重试循环、tools/check-bot-health.sh。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-bot-production',
    dependsOnIds: [],
    metadata: { files: ['packages/wechat-bot/src/index.ts', 'packages/telegram-bot/src/index.ts'] },
  },

  {
    id: 'todo-los-p1-dead-letter-classify',
    title: 'P1-8 Dead-letter 分类统计 + 自动 re-queue',
    description: 'dead_letter_events 写入后仅被 gateway startup recovery 消费。需要 governance sweep 分类统计 + 对 lease_expired 自动 re-queue。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-dead-letter-classify',
    dependsOnIds: ['todo-los-p0-governance-sweeper'],
    metadata: { files: ['packages/agent/src/dead-letter.ts', 'packages/cli/src/dead-letter.ts'] },
  },

  {
    id: 'todo-los-p1-file-sync-mtime-test',
    title: 'P1-9 File-sync mtime settle 算法独立测试',
    description: 'ae62b94 是 30 天内最大改动，但 sync-runner.ts + scanner.ts 无独立测试覆盖多节点并发写入。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-file-sync-mtime-test',
    dependsOnIds: [],
    metadata: { files: ['packages/executor/src/file-sync/scanner.ts', 'packages/executor/src/file-sync/sync-runner.ts'] },
  },

  {
    id: 'todo-los-p1-otel-docs',
    title: 'P1-10 OTel bridge 配置文档 + health endpoint',
    description: 'startOtelBridge 自动拉起但端口/协议/collector URL 无文档。需要 .env.example 补充 + health route。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-otel-docs',
    dependsOnIds: [],
    metadata: { files: ['packages/agent/src/runtime-adapter/index.ts', '.env.example'] },
  },

  {
    id: 'todo-los-p1-test-coverage',
    title: 'P1-11 Test coverage baseline + 低覆盖模块补充',
    description: '100 测试文件 / 17k 行测试代码，但整体覆盖率未知。高风险盲区：governance-sweeper/drift-sweeper/wechat-bot/telegram-bot/media。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-test-coverage',
    dependsOnIds: ['todo-los-p0-eval-probes'],
    metadata: { files: ['packages/*/src/'], targetModules: ['governance-sweeper', 'governance-drift-sweeper', 'wechat-bot', 'telegram-bot', 'media'] },
  },

  {
    id: 'todo-los-p1-turbo-cache',
    title: 'P1-12 Turbo cache behavior 文档与 CI 策略',
    description: 'turbo.json 控制构建依赖，但 CI 中可能存在 cache miss 导致重构建。需要文档化期望 cache hit behavior。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-turbo-cache',
    dependsOnIds: [],
    metadata: { files: ['turbo.json'] },
  },

  // ════════════════════════════════════════════════════════════
  // P0 — 2026-06-24 Governance Audit New Gaps (3 items)
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-p0-schema-consistency',
    title: 'P0-N1 Schema 一致性 governance job',
    description:
      '新建 schema_consistency 审计，比对 information_schema.columns 与 migration DDL，\n' +
      '检测手写 SQL 导致的 schema 漂移。\n' +
      '参考：governance-status-constraints.ts 已有相似模式。',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'audit-2026-06-24',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-schema-consistency',
    dependsOnIds: [],
    metadata: {
      problem: 'migration 漂移无法自动检测',
      solution: '加 governance job type schema_consistency，比对 column vs migration',
      files: ['packages/agent/src/governance-auditors.ts', 'packages/infra/migrations/'],
      evidence: ['tools/check-migration-drift.ts is enforced by gate-drift', 'migration_drift_fix governance audit is active', 'tools/migration-drift-baseline.txt has 0 entries'],
      resolution: 'Implemented as the migration-drift gate plus migration_drift_fix governance job.',
      statusUpdatedAt: '2026-07-15',
    },
  },
  {
    id: 'todo-los-p0-check-secrets',
    title: 'P0-N2 敏感信息 CI 扫描增强',
    description:
      '增强 check-security.sh：.env 文件 git track 检测 + 密钥模式扩展。\n' +
      '当前 check-security.sh 已有基础版本，需补充：\n' +
      '1. .env 备份文件（.env.bak, .env.local）检测\n' +
      '2. 非 .example 的 .env 类文件 git ls-files 检查\n' +
      '3. 新增密钥模式：private_key, jwt_secret, encryption_key',
    kind: 'task',
    status: 'done',
    priority: 'P0',
    source: 'audit-2026-06-24',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-check-secrets',
    dependsOnIds: [],
    metadata: {
      problem: '敏感信息扫描覆盖不足',
      files: ['tools/check-security.sh'],
      evidence: ['tracked .env variants are rejected', 'private_key, jwt_secret, and encryption_key patterns are scanned', 'executable fixture test covers the expanded rules'],
      statusUpdatedAt: '2026-07-15',
    },
  },

  // ════════════════════════════════════════════════════════════
  // P1 — 2026-06-24 Governance Audit (8 items)
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
    },
  },
  {
    id: 'todo-los-p1-los-ast-rules',
    title: 'P1-N2 los-ast 自定义规则：编码 AP1/AP3/AP5',
    description:
      '为 los-ast 编写 los 专属规则，将 AGENTS.md 中的 AP1/AP3/AP5 编码为 AST 规则：\n' +
      'AP1: Direct calls to updateTaskRun/updateTaskRunFields/updateRunSpecStatus\n' +
      'AP3: 检测 markSucceeded 前缺少 canMarkSucceeded() 调用\n' +
      'AP5: 检测 task phase 前缺少 loadSpecsForFiles() 调用\n' +
      '参考 lsclaw-governance rule pack 的 YAML 格式。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'audit-2026-06-24',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-los-ast-rules',
    dependsOnIds: [],
    metadata: {
      problem: 'AP 反模式依赖文档记忆，无自动检测',
      solution: 'AST 规则自动化 CI 扫描',
      files: ['projects/los-ast/rules/projects/los-governance/'],
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
    status: 'backlog',
    priority: 'P1',
    source: 'audit-2026-06-24',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-context-reconstruction',
    dependsOnIds: [],
    metadata: {
      problem: 'session 中断后无法恢复上下文',
      sourceMemory: 'los-remaining-backlog-2026-06-17',
      files: ['packages/agent/src/session-events.ts', 'packages/agent/src/loop/compression.ts'],
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
    dependsOnIds: [],
    metadata: {
      problem: 'CBM 注入效果未经验证',
      trigger: 'shadow sessions >= 20',
      sourceMemory: 'los-cbm-integration-backlog-2026-06-19',
      files: ['packages/gateway/src/chat-cbm-inject.ts'],
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
    },
  },
  {
    id: 'todo-los-p1-supply-chain-full',
    title: 'P1-N6 供应链完整链路',
    description:
      '扩展 supply_chain_audit job 为完整供应链审计：\n' +
      '1. SBOM 生成（cyclonedx/spdx）\n' +
      '2. License compliance check\n' +
      '3. Dependency freshness（超过 12 个月未更新的包告警）\n' +
      '4. npm audit 结果持久化到 DB 做趋势跟踪',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'audit-2026-06-24',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-supply-chain-full',
    dependsOnIds: [],
    metadata: {
      problem: 'supply_chain_audit 目前只做基础检查',
      files: ['packages/agent/src/governance-auditors-supply-chain.ts'],
    },
  },
];
