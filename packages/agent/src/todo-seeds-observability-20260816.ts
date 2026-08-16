import type { CreateTodoInput } from './todo-types.js';

/**
 * 2026-08-16 可观测性优化批次（对比 DSH 后提炼）。
 * 报告：docs/research/2026-08-16-observability-comparison-dsh.md
 * 来源：observability-comparison-2026-08-16
 */
export const OBSERVABILITY_20260816_TODO_SEED: CreateTodoInput[] = [
  {
    id: 'todo-los-obs-event-enum',
    title: '事件类型枚举化：收敛 ~90 个散落字面量为单一注册表并加机械验证',
    description:
      '把 session_events.type 的散落字符串字面量收敛为统一事件类型注册表（判别联合或 zod schema 单一真源），' +
      'appendSessionEvent 写入时校验已知类型，session-event-type-catalog.md 改为引用注册表的生成物；' +
      '新增事件类型必须过编译期/门禁，PR 标记 event-protocol-change。',
    kind: 'task',
    status: 'ready',
    priority: 'P0',
    source: 'observability-comparison-2026-08-16',
    stageId: 'observability-p0',
    dedupeKey: 'los:todo:obs-event-enum',
    metadata: {
      problem: '事件类型无统一枚举：docs/governance/session-event-type-catalog.md 是 10 域规范，但实现是分散在 30+ 文件的 ~90 个字符串字面量，visibility 分级（public/audit/internal）是事后启发式，类型漂移无门禁。',
      solution: '新建 packages/agent/src/event-types.ts 注册表（zod 判别联合覆盖现有发射点），appendSessionEvent 校验 + 开发期 warn/生产 fail，catalog 文档引用注册表。参照 DSH SessionEventMap 判别联合。',
      evidence: [
        'packages/agent/src/session-events.ts:135 session_events 表',
        'docs/governance/session-event-type-catalog.md 10 域 catalog',
        'loop.ts / execution-kernel.ts / scheduler/task-events.ts / otel-bridge.ts 等 30+ 发射点',
      ],
      validation: [
        'grep 确认 catalog 全部类型在注册表中',
        'appendSessionEvent 对未知类型在测试中抛错',
        'pnpm --filter @los/agent check',
      ],
      referenceReport: 'docs/research/2026-08-16-observability-comparison-dsh.md §5 P0-1',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-obs-trace-tree',
    title: 'trace 聚合与 span 树：trace_id 打通三表并新增跨实体时间线 API/UI',
    description:
      'trace_id 打通 session_events / task_runs / provider_call_telemetry，parent_event_id 写入真实 span 父子链；' +
      '新增 GET /traces/:traceId 时间线聚合 API，Diagnostics 页按 trace 展示跨 session/task/provider 的调用链。',
    kind: 'task',
    status: 'ready',
    priority: 'P0',
    source: 'observability-comparison-2026-08-16',
    stageId: 'observability-p0',
    dependsOnIds: ['todo-los-obs-event-enum'],
    dedupeKey: 'los:todo:obs-trace-tree',
    metadata: {
      problem: 'trace_id 只存不聚：无按 trace_id 跨 session/task/provider 的查询 API 或 UI，parent_event_id 从不写 span 父子链（G2）。',
      solution: 'event 写入时把 parentEventId 语义化为 span 父子；聚合查询按 trace_id 收敛三表；Diagnostics 页展示 trace 时间线（当前 GET /diagnostics/:traceId 只按 session 查 telemetry 行）。',
      evidence: [
        'packages/gateway/src/routes/infrastructure/diagnostics-routes.ts',
        'packages/gateway/src/routes/data/trace-routes.ts',
        'session_events.parent_event_id 列存在但无写入方',
      ],
      validation: [
        '构造多表关联 trace 的测试，/traces/:traceId 返回完整链',
        'pnpm --filter @los/gateway check',
      ],
      referenceReport: 'docs/research/2026-08-16-observability-comparison-dsh.md §5 P0-2',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-obs-replay-streaming',
    title: '回放 UI 流式化：SessionInspector 改用 trace/since 游标 + WS 增量',
    description:
      'SessionInspector 去掉 12s 轮询整段重载，改用 /trace/since 高水位游标 + WS/SSE 增量追加；' +
      '加事件跳转/加载分页控制（参照 DSH Trajectory 的加载分页 + 时间轴交互）。',
    kind: 'task',
    status: 'ready',
    priority: 'P0',
    source: 'observability-comparison-2026-08-16',
    stageId: 'observability-p0',
    dedupeKey: 'los:todo:obs-replay-streaming',
    metadata: {
      problem: '回放 UI 无流式：SessionInspector 12s 轮询整段重载，trace/since 游标与 WS 未被使用，无播放/跳转控制（G4）。',
      solution: '前端接 /trace/since（事件 id 高水位）与 WS /sessions/:id/stream/ws（stream-lease 已有），增量追加渲染；大列表虚拟化。',
      evidence: [
        'packages/web/src/pages/session-inspector.tsx',
        'packages/gateway/src/routes/data/trace-routes.ts:266 /trace/since',
        'packages/gateway/src/routes/streaming/ws-routes.ts',
      ],
      validation: [
        '实时会话中 inspector 事件增量出现不整段闪烁',
        'pnpm --filter @los/web check',
      ],
      referenceReport: 'docs/research/2026-08-16-observability-comparison-dsh.md §5 P0-3',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-obs-redaction',
    title: '写路径脱敏框架：session_events payload 与 telemetry redaction 瀑布',
    description:
      '为 session_events payload 与 provider_call_telemetry 建立 redactPayload 瀑布扩展点：' +
      '密钥模式、runtime.* 2000 字符上限推广到全事件、payload 大小/深度上限，fail-closed 单条扣留；规范日志永不重写，只作用于外发副本。',
    kind: 'task',
    status: 'ready',
    priority: 'P0',
    source: 'observability-comparison-2026-08-16',
    stageId: 'observability-p0',
    dedupeKey: 'los:todo:obs-redaction',
    metadata: {
      problem: '无脱敏框架：session_events payload/telemetry 无 redaction 瀑布，导出即原样；除 runtime.* 2000 字符上限外无大小/深度限制（G7/G12）。',
      solution: 'appendSessionEvent 与 recordProviderCall 前过统一 redactPayload 管线；默认规则含密钥模式/截断/深度限制；fail-closed。参照 DSH sessionTelemetry/record waterfall。',
      evidence: [
        'packages/agent/src/session-events.ts appendSessionEvent',
        'packages/agent/src/providers/telemetry.ts recordProviderCall',
        'runtime-task.ts 2000 字符上限先例',
      ],
      validation: [
        '注入密钥/超长 payload 的测试断言脱敏后落库',
        'pnpm --filter @los/agent check',
      ],
      referenceReport: 'docs/research/2026-08-16-observability-comparison-dsh.md §5 P0-4',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-obs-privacy-modes',
    title: '隐私三模式：telemetry 共享状态 full/feedback-only/disabled（默认 disabled）+ UI 披露',
    description:
      '为 los 增加 telemetry 共享状态（full / feedback-only / disabled，默认 disabled）；' +
      'feedback 提交（run_evals.user_feedback / todo feedback）作为 feedback-only 的释放触发器；' +
      'UI 与 API 披露当前共享状态。参照 DSH session-telemetry-otel 三模式 + sharing 属性。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'observability-comparison-2026-08-16',
    stageId: 'observability-p1',
    dependsOnIds: ['todo-los-obs-redaction'],
    dedupeKey: 'los:todo:obs-privacy-modes',
    metadata: {
      problem: '无隐私披露/共享模式：导出与 telemetry 无用户同意边界（G8）。',
      solution: '共享状态配置化，feedback-only 在 feedback 提交时释放未上报前缀，disabled 默认不采集外发。',
      evidence: ['DSH session-telemetry-otel 三模式（2026-08-05/08-10 agent notes）'],
      referenceReport: 'docs/research/2026-08-16-observability-comparison-dsh.md §5 P1-5',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-obs-charts',
    title: '趋势图表：usage/evals 页时间序列图（轻量自绘 SVG）',
    description:
      'usage 页 byDay 数据与 evals/daily-quality 加时间序列趋势图；轻量自绘 SVG 无外部依赖；' +
      'daily-quality 页展示 28 天证据窗口 collecting/complete 状态。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'observability-comparison-2026-08-16',
    stageId: 'observability-p1',
    dedupeKey: 'los:todo:obs-charts',
    metadata: {
      problem: '无真实图表：全仓无 svg/canvas/chart 库，usage/evals 无趋势图、无时间序列（G5）。',
      solution: '自绘 SVG sparkline/area chart 组件，数据已有（usage byDay、daily snapshots）。',
      evidence: ['packages/web/src/pages/usage-page.tsx byDay 数据'],
      referenceReport: 'docs/research/2026-08-16-observability-comparison-dsh.md §5 P1-6',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-obs-metrics-expand',
    title: '/metrics 扩充：进程内指标 + provider 延迟直方图 bucket',
    description:
      'GET /metrics 加进程内指标（活跃会话、SSE/WS 连接数、outbox 积压、CBM 缓存态）与 provider 延迟直方图（le 分位），' +
      '保持 DB 聚合 + 进程级混合，标签契约更新 docs/operations/metrics.md。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'observability-comparison-2026-08-16',
    stageId: 'observability-p1',
    dedupeKey: 'los:todo:obs-metrics-expand',
    metadata: {
      problem: 'Metrics 单薄：仅 DB 快照端点，无进程内指标、无直方图 bucket、无 exporter、deploy 无 collector/grafana（G6）。',
      solution: 'renderPrometheus 支持 histogram 样本类型；gateway 注册进程级收集器。',
      evidence: ['packages/infra/src/metrics.ts', 'packages/gateway/src/routes/infrastructure/metrics-routes.ts'],
      referenceReport: 'docs/research/2026-08-16-observability-comparison-dsh.md §5 P1-7',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-obs-delta-retention',
    title: 'model.delta 可选持久化：评估 ADR 0015 promotion 条件后定夺',
    description:
      '评估 ADR 0015 的 4 个 model.delta 持久化 promotion 条件（cross-gateway resume / UI 精确回放 / eval 时序 / provider 失败分析），' +
      '任一触发则带脱敏落 session_events（packed 压缩参照 DSH -60%），否则维持现状并记录结论。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'observability-comparison-2026-08-16',
    stageId: 'observability-p1',
    dependsOnIds: ['todo-los-obs-redaction'],
    dedupeKey: 'los:todo:obs-delta-retention',
    metadata: {
      problem: '无精确流回放：model.delta 不持久化（ADR 0015），UI 无法复现 token 级输出（G3）。',
      solution: '按 promotion 条件评估；若做，事件类型 + 脱敏 + packed 压缩。',
      evidence: ['docs/adr/0015-external-transcript-truncation-and-run-replay-policy.md'],
      referenceReport: 'docs/research/2026-08-16-observability-comparison-dsh.md §5 P1-8',
      statusUpdatedAt: '2026-08-16',
    },
  },
  {
    id: 'todo-los-obs-audit-search',
    title: '审计检索页：/sessions/search FTS 页面化',
    description:
      'session-events-search FTS API 已有（关键词/事件类型/时间范围），补 web 页面入口与结果列表，' +
      '支持跳转到 SessionInspector 对应事件。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'observability-comparison-2026-08-16',
    stageId: 'observability-p1',
    dedupeKey: 'los:todo:obs-audit-search',
    metadata: {
      problem: '审计出口弱：/sessions/search FTS 有 API 无页面，仅 JSON 导出 + 冷存储（G10）。',
      solution: 'nav-config 加 Search 页，接入现有 FTS 端点。',
      evidence: ['packages/agent/src/session-events-search.ts'],
      referenceReport: 'docs/research/2026-08-16-observability-comparison-dsh.md §5 P1-10',
      statusUpdatedAt: '2026-08-16',
    },
  },
];
