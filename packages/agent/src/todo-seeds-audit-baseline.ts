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
    status: 'in_progress',
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
    status: 'ready',
    priority: 'P0',
    source: 'audit-2026-06-21',
    stageId: 'p0-immediate-fixes',
    dedupeKey: 'los:todo:p0-db-schema-ddl',
    dependsOnIds: [],
    metadata: {
      problem: '双 DDL 路径导致生产 schema 与迁移历史不一致',
      solution: '全部 DDL 收敛到 migrations/；加 tools/check-migrations.sh',
      validation: 'grep -r "CREATE TABLE IF NOT EXISTS" packages/*/src/ 返回空',
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
    status: 'ready',
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
    status: 'ready',
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
    status: 'ready',
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
    status: 'ready',
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
    status: 'ready',
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
    status: 'ready',
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
    id: 'todo-los-p1-preprocessor-bench',
    title: 'P1-5 Input preprocessor benchmark + P1/P2 待办清理',
    description: '@los/input-preprocessor P0 完成但 14 项 P1/P2 待办未清。需要 benchmark log denoiser token reduction ratio + detector 正则性能。',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: 'audit-2026-06-21',
    stageId: 'p1-iteration-fixes',
    dedupeKey: 'los:todo:p1-preprocessor-bench',
    dependsOnIds: [],
    metadata: { files: ['packages/input-preprocessor/'], targetRatio: 'token reduction > 50%' },
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
];
