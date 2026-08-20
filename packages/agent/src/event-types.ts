/**
 * @los/agent/event-types — 权威 session_events.type 注册表（单一真源）。
 *
 * 现状来源：docs/governance/session-event-type-catalog.md（10 域治理文档）与
 * 全部 session_events 发射点（loop.ts / execution-kernel.ts / scheduler / otel-bridge 等）。
 * 新增事件类型必须先在此注册（catalog 规则：PR 标记 event-protocol-change）。
 *
 * 结构：
 * - SESSION_EVENT_TYPE_GROUPS：按域分组的精确类型（便于阅读与生成文档）
 * - SESSION_EVENT_TYPE_PREFIXES：前缀族（visibility 启发式与历史发射点使用
 *   `tool.pre_action.*` 这类可扩展命名，按前缀匹配）
 * - isKnownSessionEventType / assertSessionEventType：校验入口
 */
import { getLogger } from '@los/infra/logger';

const log = getLogger('event-types');

/** 精确事件类型，按域分组。 */
const SESSION_EVENT_TYPE_GROUPS = {
  session: [
    'session.started',
    'session.completed',
    'session.error',
  ],
  model: [
    'model.turn.started',
    'model.turn.completed',
    'model.response',
    'model.response.truncated',
    'model.cache',
    'model.delta',
  ],
  tool: [
    'tool.call',
    'tool.result',
    'tool.catalog',
    'tool.warned',
    'tool.requested',
    'tool.repair',
    'tool.planned',
    'tool.approved',
    'tool.denied',
    'tool.preflight_diagnostic',
    'tool.call.upsert',
  ],
  task: [
    'task.created',
    'task.running',
    'task.succeeded',
    'task.failed',
    'task.cancelled',
    'task.blocked',
    'task.recovery_followup_queued',
    'task.deduplicated',
    'agent_task.failed',
    'agent_task.requeued',
  ],
  run: [
    'run.created',
    'run.plan_approved',
    'run.plan_revised',
    'run.recovery_required',
    'run.recovery_cancelled',
    'run.operator_attention_required',
    'operator_attention_required',
    'run.blocked',
    'run.verification_failed',
    'run.plan_produced',
    'run.plan_draft',
    'run.discovery_report',
    'run.succeeded',
    'run.revision_requested',
    'run.planning_started',
    'run.planning_completed',
    'run.discovery_started',
    'run.discovery_completed',
  ],
  provider: [
    'provider.fallback.selected',
    'provider.fallback.triggered',
    'provider.fallback.exhausted',
    'provider.health_changed',
  ],
  context: [
    'context.fill.warn',
    'context.fill.checkpoint',
    'context.fill.critical',
    'context.cache.low',
  ],
  verification: [
    'verification.running',
    'verification.succeeded',
    'verification.failed',
  ],
  kernel: [
    'kernel.started',
    'kernel.finished',
    'kernel.failed',
    // execution-kernel.ts / pi-execution-kernel.ts 发射的事件（2026-08-16 补注册，
    // 此前未登记导致 appendSessionEvent 持续 WARN "Unknown session event type"）。
    'message.completed',
    'turn.completed',
    'tool.completed',
    'checkpoint.created',
  ],
  runtime: [
    'runtime.started',
    'runtime.process',
    'runtime.output',
    'runtime.completed',
    'runtime.error',
    'runtime.cancelled',
  ],
  hook: [
    'hook.succeeded',
    'hook.failed',
  ],
  operator: [
    'operator.steering',
    'operator.followup',
  ],
  usage: ['usage.recorded'],
  compaction: [
    'compaction.pre_compact',
    'compaction.post_compact',
  ],
  deadLetter: ['dead_letter.resolved'],
  worker: [
    'worker.ask',
    'worker.answered',
  ],
  architect: [
    'architect.plan.injected',
    'architect.turn',
  ],
  agentGraph: ['agent_graph.sibling_failed'],
  artifact: ['artifact.status_updated'],
  feedAnalysis: ['feed_analysis.dispatch_received'],
  /** 历史下划线命名（rule_approval 非 domain.action 风格），保留为精确类型。 */
  rule: ['rule_approval'],
  chat: [
    'user.message',
    'user.prompt',
    'turn.started',
  ],
  /** otel-bridge 映射的外部 agent span 类型（runtime-adapter/types.ts claudeSpanToEventType）。 */
  externalIngest: [
    'tool.decision',
    'hook.executed',
    'hook.registered',
    'mcp.connection',
    'permission.changed',
    'model.request',
    'model.error',
    'model.retries_exhausted',
    'auth',
    'plugin.installed',
    'plugin.loaded',
  ],
} as const;

/** 前缀族：以这些前缀开头的类型均视为已注册（可扩展命名空间）。 */
const SESSION_EVENT_TYPE_PREFIXES = [
  'tool.pre_action.',
  'tool.gate.',
  'tool_call_state.',
  'governance.',
  'ops.',
  'coordinator.',
  'skill.',
  'rule.',
  'child.agent.',
  'drill.',
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPE_GROUPS)[keyof typeof SESSION_EVENT_TYPE_GROUPS][number];

const EXACT_TYPES: ReadonlySet<string> = new Set(
  Object.values(SESSION_EVENT_TYPE_GROUPS).flat(),
);

const TYPE_PREFIXES: readonly string[] = SESSION_EVENT_TYPE_PREFIXES;

/** 类型是否已注册（精确命中或前缀族命中）。 */
export function isKnownSessionEventType(type: string): boolean {
  if (EXACT_TYPES.has(type)) return true;
  return TYPE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * 校验事件类型是否已注册。
 * 默认只告警（生产兼容：旧数据/外部摄入不阻断）；opts.fail 时抛错（测试/门禁用）。
 */
export function assertSessionEventType(
  type: string,
  opts: { fail?: boolean } = {},
): void {
  if (isKnownSessionEventType(type)) return;
  const message =
    `Unknown session event type "${type}" — register it in ` +
    `@los/agent/event-types (SESSION_EVENT_TYPE_GROUPS / SESSION_EVENT_TYPE_PREFIXES) or fix the typo`;
  if (opts.fail) throw new Error(message);
  log.warn(message);
}
