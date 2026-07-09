import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  createToolPreflightDiagnostic,
  resolveModelDiagnosticSnapshot,
  type ModelDiagnosticSnapshot,
} from './model-diagnostics.js';
import type { ProviderResponse, ToolCall } from './providers/index.js';

describe('model diagnostics', () => {
  it('flags malformed tool arguments before execution', async () => {
    const toolCalls = [toolCall('call-1', 'read_file', '{bad json')];
    const snapshot = await resolveModelDiagnosticSnapshot({
      messages: [],
      response: response({ toolCalls }),
      phase: 'execution',
      turn: 1,
      provider: 'mock',
      model: 'mock-model',
      toolCalls,
    }, undefined);

    assert.equal(snapshot?.kind, 'heuristic');
    assert.equal(snapshot?.mode, 'shadow');
    assert.equal(snapshot?.riskLevel, 'high');
    assert.ok(snapshot?.signals.includes('tool_args:invalid_json:read_file'));
    assert.deepEqual(snapshot?.recommendations[0]?.toolCallIds, ['call-1']);

    const preflight = createToolPreflightDiagnostic(snapshot, toolCalls);
    assert.equal(preflight?.riskLevel, 'high');
    assert.deepEqual(preflight?.riskyToolCallIds, ['call-1']);
  });

  it('records uncertainty without requiring a tool call', async () => {
    const snapshot = await resolveModelDiagnosticSnapshot({
      messages: [],
      response: response({ text: 'I am not sure; this might be missing context.' }),
      phase: 'planning',
      turn: 0,
      provider: 'mock',
      model: 'mock-model',
      toolCalls: [],
    }, undefined);

    assert.equal(snapshot?.phase, 'planning');
    assert.equal(snapshot?.riskLevel, 'medium');
    assert.ok(snapshot?.signals.includes('uncertainty:not_sure'));
    assert.ok(snapshot?.signals.includes('uncertainty:might'));
    assert.ok(snapshot?.recommendations.some(item => item.type === 'clarify'));
  });

  it('uses an external probe when one is configured', async () => {
    const external: ModelDiagnosticSnapshot = {
      kind: 'j_lens',
      source: 'local-sidecar',
      mode: 'shadow',
      phase: 'execution',
      riskLevel: 'high',
      confidence: 2,
      scores: {
        uncertainty: 0.1,
        toolArgumentRisk: 0,
        completionRisk: 0,
        reasoningRisk: 0.8,
      },
      signals: ['j_space:wrong'],
      concepts: [{ token: 'wrong', layer: 42, rank: 1 }],
      recommendations: [{ type: 'verify', reason: 'sidecar detected a wrong-token concept' }],
    };

    const snapshot = await resolveModelDiagnosticSnapshot({
      messages: [],
      response: response({ text: 'done' }),
      phase: 'execution',
      turn: 1,
      provider: 'mock',
      model: 'mock-model',
      toolCalls: [],
    }, {
      probe: { inspectTurn: () => external },
    });

    assert.equal(snapshot?.kind, 'j_lens');
    assert.equal(snapshot?.source, 'local-sidecar');
    assert.equal(snapshot?.confidence, 1);
  });

  it('can be disabled for runs that do not want diagnostic payloads', async () => {
    const snapshot = await resolveModelDiagnosticSnapshot({
      messages: [],
      response: response({ text: 'maybe' }),
      phase: 'execution',
      turn: 1,
      provider: 'mock',
      model: 'mock-model',
      toolCalls: [],
    }, {
      enabled: false,
    });

    assert.equal(snapshot, undefined);
  });
});

function response(overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    text: '',
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1 },
    model: 'mock-model',
    ...overrides,
  };
}

function toolCall(id: string, name: string, args: string): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: args,
    },
  };
}
