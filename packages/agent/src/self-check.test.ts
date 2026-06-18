import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '@los/infra/db';
import { ensureTaskRunStore } from './task-runs.js';
import { ensureExecutorNodeStore } from './executor-nodes.js';

import {
  runPostExecutionSelfCheck,
  buildSelfCheckPrompt,
  parseSelfCheckResponse,
  shouldRunSelfCheck,
  summarizeAgentContext,
  CONFIDENCE_GATE_THRESHOLD,
  type SelfCheckInput,
  type SelfCheckResult,
} from './self-check.js';
import type { AgentResult } from './loop.js';
import type { Provider, ProviderResponse, Message, ToolDef } from './providers/types.js';

function createFakeProvider(responseText: string): Provider {
  return {
    name: 'test',
    profile: {
      provider: 'test',
      protocol: 'openai' as any,
      apiShape: 'chat_completion' as any,
      baseUrl: '',
      model: 'test',
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsReasoning: false,
      cachePolicy: {} as any,
      toolCallRepair: 'never' as any,
      usageMapping: { promptTokens: [], completionTokens: [], cacheHitTokens: [], cacheMissTokens: [], totalTokens: [] },
      retryPolicy: {} as any,
      knownFailurePatterns: [],
    },
    async chat(_messages: Message[], _tools?: ToolDef[]): Promise<ProviderResponse> {
      return {
        text: responseText,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5 },
        model: 'test',
      };
    },
  };
}

function makeInput(overrides?: Partial<SelfCheckInput>): SelfCheckInput {
  return {
    goal: 'list directory contents',
    stopConditions: ['directory listing produced', 'output contains file names'],
    agentOutput: 'I listed the directory and found files: a.ts, b.ts, c.ts. All three TypeScript files were found in the src directory.',
    contextSummary: '1 turns executed\nTurn 1: tools=[list_dir] results=[a.ts, b.ts, c.ts]',
    provider: createFakeProvider(
      JSON.stringify({
        goalMet: true,
        stopConditionsMet: [true, true],
        summaryOfEvidence: 'agent output lists three files explicitly',
        confidence: 0.95,
        gaps: [],
      }),
    ),
    ...overrides,
  };
}

// ── Unit: buildSelfCheckPrompt ──

test('buildSelfCheckPrompt includes goal and all stop conditions', () => {
  const input = makeInput();
  const messages = buildSelfCheckPrompt(input);
  assert.ok(messages.length >= 2);
  const userContent = messages[1]?.content ?? '';
  assert.ok(userContent.includes('list directory contents'), 'contains goal');
  assert.ok(userContent.includes('directory listing produced'), 'contains stop condition 1');
  assert.ok(userContent.includes('output contains file names'), 'contains stop condition 2');
});

test('buildSelfCheckPrompt handles empty stop conditions', () => {
  const messages = buildSelfCheckPrompt(makeInput({ stopConditions: [] }));
  const userContent = messages[1]?.content ?? '';
  assert.ok(userContent.includes('(none specified)'));
});

test('buildSelfCheckPrompt includes agent output', () => {
  const messages = buildSelfCheckPrompt(makeInput());
  const userContent = messages[1]?.content ?? '';
  assert.ok(userContent.includes('a.ts, b.ts, c.ts'));
});

test('buildSelfCheckPrompt includes context summary', () => {
  const messages = buildSelfCheckPrompt(makeInput());
  const userContent = messages[1]?.content ?? '';
  assert.ok(userContent.includes('list_dir'));
});

// ── Unit: parseSelfCheckResponse ──

test('parseSelfCheckResponse handles valid JSON', () => {
  const result = parseSelfCheckResponse(
    JSON.stringify({
      goalMet: true,
      stopConditionsMet: [true, true],
      summaryOfEvidence: 'found files',
      confidence: 0.9,
      gaps: [],
    }),
    2,
  );
  assert.equal(result.goalMet, true);
  assert.deepEqual(result.stopConditionsMet, [true, true]);
  assert.equal(result.summaryOfEvidence, 'found files');
  assert.equal(result.confidence, 0.9);
  assert.deepEqual(result.gaps, []);
});

test('parseSelfCheckResponse handles valid JSON with gaps', () => {
  const result = parseSelfCheckResponse(
    JSON.stringify({
      goalMet: false,
      stopConditionsMet: [true, false],
      summaryOfEvidence: 'partial',
      confidence: 0.3,
      gaps: [
        {
          condition: 'output',
          detail: 'missing file names',
          suggestion: 're-run with list_dir tool',
        },
      ],
    }),
    2,
  );
  assert.equal(result.goalMet, false);
  assert.deepEqual(result.stopConditionsMet, [true, false]);
  assert.equal(result.confidence, 0.3);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].condition, 'output');
  assert.equal(result.gaps[0].suggestion, 're-run with list_dir tool');
});

test('parseSelfCheckResponse handles JSON with code fence', () => {
  const result = parseSelfCheckResponse(
    '```json\n' + JSON.stringify({
      goalMet: true,
      stopConditionsMet: [true],
      summaryOfEvidence: 'ok',
      confidence: 0.85,
      gaps: [],
    }) + '\n```',
    1,
  );
  assert.equal(result.goalMet, true);
  assert.equal(result.confidence, 0.85);
});

test('parseSelfCheckResponse fallback on garbled text', () => {
  const result = parseSelfCheckResponse('not json at all', 2);
  assert.equal(result.goalMet, false);
  assert.deepEqual(result.stopConditionsMet, [false, false]);
  assert.equal(result.gaps[0].condition, 'self_check_parse');
});

test('parseSelfCheckResponse fallback on empty string', () => {
  const result = parseSelfCheckResponse('', 1);
  assert.equal(result.goalMet, false);
  assert.equal(result.gaps[0].condition, 'self_check_parse');
});

test('parseSelfCheckResponse normalizes mismatched stop conditions count', () => {
  // Response has 1 entry but expectedCount is 3 → all false
  const result = parseSelfCheckResponse(
    JSON.stringify({
      goalMet: true,
      stopConditionsMet: [true],
      summaryOfEvidence: '',
      confidence: 0.5,
      gaps: [],
    }),
    3,
  );
  assert.deepEqual(result.stopConditionsMet, [false, false, false]);
  assert.equal(result.confidence, 0.5);
});

// ── Unit: shouldRunSelfCheck ──

test('shouldRunSelfCheck false when contract undefined', () => {
  assert.equal(shouldRunSelfCheck(undefined), false);
});

test('shouldRunSelfCheck false when selfCheckEnabled: false', () => {
  assert.equal(shouldRunSelfCheck({ goal: 'do X', selfCheckEnabled: false }), false);
});

test('shouldRunSelfCheck false when no goal and no stop conditions', () => {
  assert.equal(shouldRunSelfCheck({ stopConditions: [] }), false);
});

test('shouldRunSelfCheck true when goal is set', () => {
  assert.equal(shouldRunSelfCheck({ goal: 'do X' }), true);
});

test('shouldRunSelfCheck true when stop conditions are set', () => {
  assert.equal(shouldRunSelfCheck({ stopConditions: ['condition 1'] }), true);
});

test('shouldRunSelfCheck true when both set', () => {
  assert.equal(shouldRunSelfCheck({ goal: 'X', stopConditions: ['Y'] }), true);
});

// ── Unit: selfCheckPassed combinatorics ──

test('SelfCheckResult.selfCheckPassed = true when goalMet and all conditions met', async () => {
  const result = await runPostExecutionSelfCheck(makeInput());
  assert.equal(result.selfCheckPassed, true);
  assert.equal(result.skipped, false);
  assert.ok(result.confidence >= 0.9, `confidence ${result.confidence} should be >= 0.9`);
});

test('SelfCheckResult.selfCheckPassed = false when goalMet is false', async () => {
  const result = await runPostExecutionSelfCheck(
    makeInput({
      provider: createFakeProvider(
        JSON.stringify({
          goalMet: false,
          stopConditionsMet: [true, true],
          summaryOfEvidence: '',
          confidence: 0.2,
          gaps: [{ condition: 'goal', detail: 'not met', suggestion: 'retry' }],
        }),
      ),
    }),
  );
  assert.equal(result.selfCheckPassed, false);
  assert.equal(result.confidence, 0.2);
});

test('SelfCheckResult.selfCheckPassed = false when stop condition not met', async () => {
  const result = await runPostExecutionSelfCheck(
    makeInput({
      provider: createFakeProvider(
        JSON.stringify({
          goalMet: true,
          stopConditionsMet: [true, false],
          summaryOfEvidence: '',
          confidence: 0.45,
          gaps: [{ condition: 'stop', detail: 'not met', suggestion: 'fix' }],
        }),
      ),
    }),
  );
  assert.equal(result.selfCheckPassed, false);
});

test('SelfCheckResult selfCheckPassed = true when stop conditions empty and goal met', async () => {
  const result = await runPostExecutionSelfCheck(
    makeInput({
      stopConditions: [],
      provider: createFakeProvider(
        JSON.stringify({
          goalMet: true,
          stopConditionsMet: [],
          summaryOfEvidence: 'done',
          confidence: 0.92,
          gaps: [],
        }),
      ),
    }),
  );
  assert.equal(result.selfCheckPassed, true);
});

// ── Unit: pre-check skip for empty output ──

test('pre-check skips LLM call when agent output is empty', async () => {
  const result = await runPostExecutionSelfCheck(makeInput({ agentOutput: '' }));
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'empty_output');
  assert.equal(result.selfCheckPassed, false);
  assert.equal(result.confidence, 0);
  assert.equal(result.gaps[0].condition, 'output');
});

test('pre-check skips LLM call when agent output is too short', async () => {
  const result = await runPostExecutionSelfCheck(makeInput({ agentOutput: 'ok' }));
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'output_too_short');
  assert.equal(result.confidence, 0);
});

// ── Unit: summarizeAgentContext ──

test('summarizeAgentContext produces non-empty summary', () => {
  const result: AgentResult = {
    text: 'done',
    turns: [
      {
        loopCount: 1,
        text: 'listing files',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }],
        toolResults: ['a.ts\nb.ts'],
      },
    ],
    loopCount: 1,
    totalTokens: { prompt: 100, completion: 50 },
    messages: [],
  };
  const summary = summarizeAgentContext(result);
  assert.ok(summary.includes('1 turns executed'));
  assert.ok(summary.includes('list_dir'));
  assert.ok(summary.includes('a.ts'));
});

// ── Unit: provider failure produces safe result ──

test('provider failure returns selfCheckPassed: false with error gap', async () => {
  const failingProvider: Provider = {
    name: 'fail',
    profile: {
      provider: 'fail',
      protocol: 'openai' as any,
      apiShape: 'chat_completion' as any,
      baseUrl: '',
      model: 'fail',
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsReasoning: false,
      cachePolicy: {} as any,
      toolCallRepair: 'never' as any,
      usageMapping: { promptTokens: [], completionTokens: [], cacheHitTokens: [], cacheMissTokens: [], totalTokens: [] },
      retryPolicy: {} as any,
      knownFailurePatterns: [],
    },
    async chat(): Promise<ProviderResponse> {
      throw new Error('provider unavailable');
    },
  };
  const result = await runPostExecutionSelfCheck(makeInput({ provider: failingProvider }));
  assert.equal(result.selfCheckPassed, false);
  assert.equal(result.skipped, false);
  assert.equal(result.confidence, 0);
  assert.equal(result.gaps[0].condition, 'self_check_provider');
  assert.ok(result.gaps[0].detail.includes('provider unavailable'));
});

// ── Integration tests ──

test('integration: self-check result shape round-trips through parse', async () => {
  // Verify the full pipeline: provider returns valid JSON → parsed → result computed
  const result = await runPostExecutionSelfCheck(makeInput());
  assert.equal(result.selfCheckPassed, true);
  assert.equal(result.goalMet, true);
  assert.deepEqual(result.stopConditionsMet, [true, true]);
  assert.ok(result.confidence >= 0, 'confidence should be a number');
  assert.ok(result.evaluatedAt);
  assert.ok(typeof result.rawResponse === 'string');
});

test('integration: self-check with gaps produces structured gap report', async () => {
  const result = await runPostExecutionSelfCheck(
    makeInput({
      provider: createFakeProvider(
        JSON.stringify({
          goalMet: false,
          stopConditionsMet: [false, false],
          summaryOfEvidence: 'agent did not produce a listing',
          confidence: 0.15,
          gaps: [
            {
              condition: 'directory listing produced',
              detail: 'no directory listing in output',
              suggestion: 'run list_dir tool and confirm output',
            },
            {
              condition: 'output contains file names',
              detail: 'no file names visible',
              suggestion: 'list files explicitly',
            },
          ],
        }),
      ),
    }),
  );
  assert.equal(result.selfCheckPassed, false);
  assert.equal(result.confidence, 0.15);
  assert.equal(result.gaps.length, 2);
  assert.equal(result.gaps[0].condition, 'directory listing produced');
  assert.ok(result.gaps[0].suggestion.length > 0);
  assert.equal(result.gaps[1].condition, 'output contains file names');
});

// ── Confidence-specific tests ──

test('confidence default: goalMet=true without explicit confidence gives 0.5', () => {
  const result = parseSelfCheckResponse(
    JSON.stringify({
      goalMet: true,
      stopConditionsMet: [true],
      summaryOfEvidence: '',
      gaps: [],
    }),
    1,
  );
  assert.equal(result.goalMet, true);
  assert.equal(result.confidence, 0.5);
});

test('confidence default: goalMet=false without explicit confidence gives 0', () => {
  const result = parseSelfCheckResponse(
    JSON.stringify({
      goalMet: false,
      stopConditionsMet: [false],
      summaryOfEvidence: '',
      gaps: [],
    }),
    1,
  );
  assert.equal(result.confidence, 0);
});

test('confidence clamped to [0, 1] range', () => {
  const high = parseSelfCheckResponse(
    JSON.stringify({ goalMet: true, stopConditionsMet: [], summaryOfEvidence: '', confidence: 2.5, gaps: [] }),
    0,
  );
  assert.equal(high.confidence, 1);

  const low = parseSelfCheckResponse(
    JSON.stringify({ goalMet: false, stopConditionsMet: [], summaryOfEvidence: '', confidence: -0.5, gaps: [] }),
    0,
  );
  assert.equal(low.confidence, 0);
});

test('CONFIDENCE_GATE_THRESHOLD is a number between 0 and 1', () => {
  assert.ok(typeof CONFIDENCE_GATE_THRESHOLD === 'number');
  assert.ok(CONFIDENCE_GATE_THRESHOLD > 0 && CONFIDENCE_GATE_THRESHOLD < 1);
});

test('low-confidence output selfCheckPassed=true but confidence < threshold', async () => {
  // Self-check passes all conditions but judge has low confidence.
  // The gate check happens in goal-self-check-runner, not here.
  // This test verifies the result shape is correct for the gate to consume.
  const result = await runPostExecutionSelfCheck(
    makeInput({
      provider: createFakeProvider(
        JSON.stringify({
          goalMet: true,
          stopConditionsMet: [true, true],
          summaryOfEvidence: 'found files but uncertain about completeness',
          confidence: 0.45,
          gaps: [],
        }),
      ),
    }),
  );
  assert.equal(result.selfCheckPassed, true, 'conditions met');
  assert.ok(result.confidence < CONFIDENCE_GATE_THRESHOLD, `confidence ${result.confidence} < ${CONFIDENCE_GATE_THRESHOLD}`);
  // The gate runner will block this, but the raw self-check result says "pass"
});
