import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { isKnownSessionEventType } from './event-types.js';

/**
 * 事件类型完备性机械验证（DSH 事件分类学验证同款，2026-08-18 R-LOS-02）。
 *
 * 扫描 agent + gateway 源码里所有 `type: '<literal>'` 字面量，断言每个都已在
 * event-types 注册表（精确类型或前缀族）登记。新增事件类型/拼写错误会在本测试
 * 失败——这是"新增事件类型必须过门禁"的机械落地（catalog 规则 event-protocol-change）。
 *
 * 白名单 = 非 session_events.type 的 `type:` 字段（协议/JSON-schema/OAuth/错误码
 * 等）。新增误报必须带注释说明为什么不是事件类型，禁止无注释扩充。
 */

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));

const SRC_DIRS = [
  path.join(PACKAGES, 'agent/src'),
  path.join(PACKAGES, 'gateway/src'),
];

/**
 * 已知非事件类型的 `type: '...'` 字面量白名单。
 * 分类：
 * - json_schema: zod/schema 的 type 字段（'string'/'object'/...）
 * - oauth_auth: OAuth grant/header 类型
 * - openai_error: OpenAI 兼容错误码
 * - protocol: SSE/WS/worker 消息协议 chunk.type
 * - payload_error: session.completed.errorSummary 的错误类别（payload 内字段，
 *   不写 session_events.type；对应事件类型是 model.response.truncated / tool.repair）
 * - intent: message-router intent 类型
 * - metrics: Prometheus 指标类型
 * - worker_msg: worker_messages 表 CHECK 约束类型（非 session_events）
 * - timeline_synthetic: /diagnostics timeline 的合成 source 标记
 * - misc: 其他明确非事件字段
 */
const NON_EVENT_TYPE_LITERALS = new Set<string>([
  // json_schema
  'string', 'object', 'array', 'boolean', 'number', 'integer', 'function', 'null',
  // protocol / chunk types
  'session_event', 'message', 'message.delta', 'text', 'result', 'done',
  'refresh_token', 'function_call', 'function_call_output', 'tool_use', 'tool_result',
  'type_alias_declaration', 'unknown', 'heartbeat', 'observation', 'kernel_event',
  'escalation', 'verify', 'status', 'selected', 'enabled', 'disabled', 'steering', 'todo',
  // oauth_auth
  'authorization_code', 'code', 'Bearer',
  // openai_error
  'insufficient_permissions', 'internal_error', 'invalid_request_error',
  // payload_error（session.completed.errorSummary 错误类别）
  'max_loops_reached', 'truncated_response', 'tool_parse_error', 'tool_repair',
  // payload_error（session-recovery recoverySummary.errorEvents 类别）
  'checkpoint_lookup_failed', 'checkpoint_version_incompatible', 'event_load_failed',
  // intent（message-router intent.type 字段）
  'chat', 'governance', 'runtime', 'run_contract',
  // metrics
  'counter', 'gauge',
  // worker_msg（worker_messages 表，非 session_events）
  'worker_done', 'ask',
  // timeline_synthetic
  'provider.call',
  // misc
  'json', 'image', 'exhausted', 'followup', 'observe', 'retry',
  'operator.coordinator.wake', 'related_project_scan', 'toolCall',
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') continue;
      walk(p, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(p);
    }
  }
}

function collectTypeLiterals(): Map<string, string[]> {
  const files: string[] = [];
  for (const dir of SRC_DIRS) walk(dir, files);

  const found = new Map<string, string[]>();
  const re = /type:\s*'([^']+)'/g;
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const t = m[1];
      if (NON_EVENT_TYPE_LITERALS.has(t)) continue;
      const rel = path.relative(PACKAGES, file);
      if (!found.has(t)) found.set(t, []);
      found.get(t)!.push(rel);
    }
  }
  return found;
}

describe('event-type completeness (scanned literals vs registry)', () => {
  const literals = collectTypeLiterals();

  it('scans a meaningful number of type literals (sanity floor)', () => {
    // 注册表精确类型 + 前缀族发射点应远多于抽样；低于下限说明扫描路径失效。
    assert.ok(literals.size >= 60, `expected >= 60 scanned type literals, got ${literals.size}`);
  });

  it('every `type: \'...\'` literal in agent/gateway source is registered', () => {
    const unknown: Array<{ type: string; files: string[] }> = [];
    for (const [t, files] of literals) {
      if (!isKnownSessionEventType(t)) unknown.push({ type: t, files: [...new Set(files)] });
    }
    unknown.sort((a, b) => a.type.localeCompare(b.type));
    const detail = unknown
      .map(u => `  ${u.type} ← ${u.files.slice(0, 3).join(', ')}`)
      .join('\n');
    assert.equal(
      unknown.length,
      0,
      `Unregistered session event types found — register them in event-types.ts ` +
        `(SESSION_EVENT_TYPE_GROUPS / SESSION_EVENT_TYPE_PREFIXES) or add to the ` +
        `non-event whitelist with a reason:\n${detail}`,
    );
  });

  it('all catalog-documented run/task/session/provider types are registered', () => {
    // catalog（docs/governance/session-event-type-catalog.md）列的 10 域代表类型，
    // 双保险：即使源码扫描因重构漏过，文档承诺的类型也不能漂移。
    const catalogRepresentatives = [
      'run.created', 'run.plan_approved', 'run.plan_revised',
      'run.recovery_required', 'run.recovery_cancelled', 'run.operator_attention_required',
      'task.created', 'task.running', 'task.succeeded', 'task.failed',
      'task.cancelled', 'task.blocked', 'task.recovery_followup_queued',
      'context.fill.warn', 'context.fill.checkpoint', 'context.fill.critical',
      'provider.fallback.selected', 'provider.fallback.triggered',
      'verification.running', 'verification.succeeded', 'verification.failed',
      'kernel.started', 'kernel.finished', 'kernel.failed',
      'message.completed',
    ];
    for (const t of catalogRepresentatives) {
      assert.equal(isKnownSessionEventType(t), true, `${t} should be registered`);
    }
  });
});
