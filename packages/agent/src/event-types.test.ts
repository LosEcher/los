import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSessionEventType,
  isKnownSessionEventType,
} from './event-types.js';

// 每组抽查代表类型（注册表内部常量不导出，保持导出面收敛）。
const REPRESENTATIVE_TYPES = [
  'session.started', 'session.completed', 'session.error',
  'model.turn.started', 'model.turn.completed', 'model.response',
  'model.response.truncated', 'model.cache', 'model.delta',
  'tool.call', 'tool.result', 'tool.catalog', 'tool.warned',
  'tool.requested', 'tool.repair', 'tool.planned', 'tool.preflight_diagnostic',
  'tool.call.upsert', 'tool.approved', 'tool.denied',
  'task.created', 'task.running', 'task.succeeded', 'task.failed',
  'task.cancelled', 'task.blocked', 'task.recovery_followup_queued', 'task.deduplicated',
  'agent_task.failed', 'agent_task.requeued',
  'run.created', 'run.plan_approved', 'run.plan_revised',
  'run.recovery_required', 'run.recovery_cancelled', 'run.operator_attention_required',
  'operator_attention_required',
  'run.blocked', 'run.verification_failed', 'run.plan_produced', 'run.plan_draft',
  'run.discovery_report', 'run.succeeded', 'run.revision_requested',
  'run.planning_started', 'run.planning_completed',
  'run.discovery_started', 'run.discovery_completed',
  'context.fill.warn', 'context.fill.checkpoint', 'context.fill.critical', 'context.cache.low',
  'provider.fallback.selected', 'provider.fallback.triggered',
  'provider.fallback.exhausted', 'provider.health_changed',
  'verification.running', 'verification.succeeded', 'verification.failed',
  'kernel.started', 'kernel.finished', 'kernel.failed',
  'message.completed', 'turn.completed', 'tool.completed', 'checkpoint.created',
  'runtime.started', 'runtime.process', 'runtime.output',
  'runtime.completed', 'runtime.error', 'runtime.cancelled',
  'hook.succeeded', 'hook.failed',
  'operator.steering', 'operator.followup',
  'usage.recorded',
  'compaction.pre_compact', 'compaction.post_compact',
  'dead_letter.resolved',
  'worker.ask', 'worker.answered',
  'architect.plan.injected', 'architect.turn',
  'agent_graph.sibling_failed',
  'artifact.status_updated',
  'feed_analysis.dispatch_received',
  'rule_approval',
  'user.message', 'user.prompt', 'turn.started',
  'tool.decision', 'hook.executed', 'hook.registered', 'mcp.connection',
  'permission.changed', 'model.request', 'model.error',
  'model.retries_exhausted', 'auth', 'plugin.installed', 'plugin.loaded',
];

describe('event-types registry', () => {
  it('recognizes exact registered types from every group', () => {
    for (const type of REPRESENTATIVE_TYPES) {
      assert.equal(isKnownSessionEventType(type), true, `${type} should be known`);
    }
  });

  it('recognizes prefix families', () => {
    assert.equal(isKnownSessionEventType('tool.pre_action.fragile_file.removed'), true);
    assert.equal(isKnownSessionEventType('tool.gate.feedback.fail'), true);
    assert.equal(isKnownSessionEventType('tool_call_state.updated'), true);
    assert.equal(isKnownSessionEventType('governance.sweep.started'), true);
    assert.equal(isKnownSessionEventType('ops.daily_digest'), true);
    assert.equal(isKnownSessionEventType('coordinator.context_policy_selected'), true);
    assert.equal(isKnownSessionEventType('skill.selected'), true);
    assert.equal(isKnownSessionEventType('rule.enforced'), true);
    assert.equal(isKnownSessionEventType('child.agent.spawned'), true);
    assert.equal(isKnownSessionEventType('drill.event.one'), true);
    assert.equal(isKnownSessionEventType('drill.outbox.pending'), true);
  });

  it('rejects unknown types', () => {
    assert.equal(isKnownSessionEventType('definitely.not.a.real.type'), false);
    assert.equal(isKnownSessionEventType(''), false);
    assert.equal(isKnownSessionEventType('session'), false); // bare domain, not an event
  });

  it('assert passes silently for known types', () => {
    assert.doesNotThrow(() => assertSessionEventType('session.started'));
    assert.doesNotThrow(() => assertSessionEventType('tool.result'));
  });

  it('assert warns (default) and throws (fail) for unknown types', () => {
    // Default: no throw (production-compatible warn path).
    assert.doesNotThrow(() => assertSessionEventType('not.registered.event'));
    // Fail mode: throws with actionable message.
    assert.throws(
      () => assertSessionEventType('not.registered.event', { fail: true }),
      /Unknown session event type "not.registered.event"/,
    );
  });
});
