import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '@los/infra/db';
import { ensureTaskRunStore } from './task-runs.js';
import { ensureExecutorNodeStore } from './executor-nodes.js';

import {
  runPostExecutionSelfCheck,
  buildSelfCheckPrompt,
  parseSelfCheckResponse,
  _validateSelfCheckOutput,
  shouldRunSelfCheck,
  summarizeAgentContext,
  buildReviewPacket,
  CONFIDENCE_GATE_THRESHOLD,
  type SelfCheckInput,
  type SelfCheckResult,
  type ReviewPacket,
} from './self-check.js';
import type { AgentResult } from './loop.js';
import type { Provider, ProviderResponse, Message, ToolDef, ChatOptions } from './providers/types.js';

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

test('parseSelfCheckResponse extracts JSON wrapped in tool-call noise', () => {
  const noisy = '<tool_calls>\n<read_file file="docs/governance/anti-patterns.md" />\n' +
    '{"goalMet": true, "stopConditionsMet": [true], "summaryOfEvidence": "read the doc", "confidence": 0.8, "gaps": []}\n' +
    '</tool_calls>';
  const result = parseSelfCheckResponse(noisy, 1);
  assert.equal(result.goalMet, true);
  assert.equal(result.confidence, 0.8);
  assert.deepEqual(result.stopConditionsMet, [true]);
});

test('parseSelfCheckResponse extracts JSON with prose prefix', () => {
  const result = parseSelfCheckResponse('Here is my assessment: {"goalMet": false, "stopConditionsMet": [false], "summaryOfEvidence": "x", "confidence": 0.3, "gaps": [{"condition":"g","detail":"d","suggestion":"s"}]}', 1);
  assert.equal(result.goalMet, false);
  assert.equal(result.confidence, 0.3);
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

test('parseSelfCheckResponse contract: missing goalMet fails explicitly', () => {
  const result = parseSelfCheckResponse(
    JSON.stringify({
      stopConditionsMet: [true],
      summaryOfEvidence: 'x',
      confidence: 0.5,
      gaps: [],
    }),
    1,
  );
  assert.equal(result.goalMet, false);
  assert.equal(result.gaps[0].condition, 'self_check_parse');
  assert.match(result.gaps[0].detail, /goalMet must be a boolean/);
});

test('parseSelfCheckResponse contract: missing confidence no longer silently defaults', () => {
  // Regression: previously a missing confidence degraded to 0.5 when goalMet,
  // making the verdict indistinguishable from a real judge call.
  const result = parseSelfCheckResponse(
    JSON.stringify({
      goalMet: true,
      stopConditionsMet: [true],
      summaryOfEvidence: 'x',
      gaps: [],
    }),
    1,
  );
  assert.equal(result.gaps[0].condition, 'self_check_parse');
  assert.match(result.gaps[0].detail, /confidence must be a finite number/);
});

test('parseSelfCheckResponse contract: non-array gaps fails explicitly', () => {
  const result = parseSelfCheckResponse(
    JSON.stringify({
      goalMet: true,
      stopConditionsMet: [true],
      summaryOfEvidence: 'x',
      confidence: 0.9,
      gaps: 'none',
    }),
    1,
  );
  assert.equal(result.gaps[0].condition, 'self_check_parse');
  assert.match(result.gaps[0].detail, /gaps must be an array/);
});

test('parseSelfCheckResponse contract: malformed gap entry fails explicitly', () => {
  const result = parseSelfCheckResponse(
    JSON.stringify({
      goalMet: true,
      stopConditionsMet: [true],
      summaryOfEvidence: 'x',
      confidence: 0.9,
      gaps: [{ condition: 'g' }],
    }),
    1,
  );
  assert.equal(result.gaps[0].condition, 'self_check_parse');
  assert.match(result.gaps[0].detail, /string condition\/detail\/suggestion/);
});

test('_validateSelfCheckOutput accepts a fully valid output', () => {
  const validation = _validateSelfCheckOutput({
    goalMet: true,
    stopConditionsMet: [true, false],
    summaryOfEvidence: '  evidence here  ',
    confidence: 0.8,
    gaps: [{ condition: 'c', detail: 'd', suggestion: 's' }],
  }, 2);
  assert.equal(validation.ok, true);
  if (validation.ok) {
    assert.equal(validation.output.summaryOfEvidence, 'evidence here');
    assert.deepEqual(validation.output.stopConditionsMet, [true, false]);
  }
});

// ── Unit: runPostExecutionSelfCheck pass semantics ──

test('selfCheckPassed requires only goalMet, not stop conditions', async () => {
  // Regression: a task that completes normally never triggers a stop condition
  // (e.g. scheduled execution's 'operator cancels schedule'), so a goalMet=true
  // verdict with stopConditionsMet=[false] must still pass; otherwise every
  // well-finished scheduled task is blocked and the circuit breaker trips.
  const result = await runPostExecutionSelfCheck(
    makeInput({
      stopConditions: ['operator cancels schedule'],
      provider: createFakeProvider(
        JSON.stringify({
          goalMet: true,
          stopConditionsMet: [false],
          summaryOfEvidence: 'task completed normally, no cancellation observed',
          confidence: 0.95,
          gaps: [],
        }),
      ),
    }),
  );
  assert.equal(result.goalMet, true);
  assert.equal(result.selfCheckPassed, true);
  assert.deepEqual(result.stopConditionsMet, [false]);
});

test('selfCheckPassed false when goal not met even if stop conditions met', async () => {
  const result = await runPostExecutionSelfCheck(
    makeInput({
      provider: createFakeProvider(
        JSON.stringify({
          goalMet: false,
          stopConditionsMet: [true, true],
          summaryOfEvidence: 'partial work only',
          confidence: 0.4,
          gaps: [{ condition: 'goal', detail: 'output missing', suggestion: 're-run' }],
        }),
      ),
    }),
  );
  assert.equal(result.goalMet, false);
  assert.equal(result.selfCheckPassed, false);
});

test('self-check passes modelSettings and sessionId to the judge call', async () => {
  let capturedOptions: unknown;
  const capturingProvider: Provider = {
    ...createFakeProvider('{"goalMet": true, "stopConditionsMet": [false], "summaryOfEvidence": "ok", "confidence": 0.9, "gaps": []}'),
    chat: async (_m: Message[], _t?: ToolDef[], options?: ChatOptions) => {
      capturedOptions = options;
      return { text: '{"goalMet": true, "stopConditionsMet": [false], "summaryOfEvidence": "ok", "confidence": 0.9, "gaps": []}', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 }, model: 'test' };
    },
  };
  const result = await runPostExecutionSelfCheck(
    makeInput({
      provider: capturingProvider,
      sessionId: 'session-abc',
      modelSettings: { thinking: 'disabled', maxTokens: 1024 },
    }),
  );
  assert.equal(result.selfCheckPassed, true);
  const opts = capturedOptions as ChatOptions;
  assert.equal(opts.sessionId, 'session-abc');
  assert.deepEqual(opts.modelSettings, { thinking: 'disabled', maxTokens: 1024 });
  assert.ok(opts.signal instanceof AbortSignal, 'timeout signal must be attached');
});

test('self-check timeout aborts the judge call with a timeout gap', async () => {
  const hangingProvider: Provider = {
    ...createFakeProvider(''),
    chat: async (_m: Message[], _t?: ToolDef[], options?: ChatOptions) => {
      // Honor the abort signal: never resolve, reject on abort.
      return await new Promise<ProviderResponse>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    },
  };
  const result = await runPostExecutionSelfCheck(
    makeInput({ provider: hangingProvider, timeoutMs: 100 }),
  );
  assert.equal(result.selfCheckPassed, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.gaps[0]?.condition, 'self_check_timeout');
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

test('SelfCheckResult.selfCheckPassed = true when goal met even if a stop condition was not triggered', async () => {
  // Stop conditions are audit information; a normally-completed task (e.g.
  // scheduled execution where 'operator cancels schedule' never fires) must
  // not be failed for not triggering them. This test pins the fixed semantics
  // (previously: goalMet=true + stopConditionsMet=[true,false] → failed).
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
  assert.equal(result.selfCheckPassed, true);
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
});

// ── Unit: buildReviewPacket ──

function makeTurn(loopCount: number, calls: Array<{ name: string; args: Record<string, unknown> }>): AgentResult['turns'][number] {
  return {
    loopCount,
    text: `turn ${loopCount}`,
    toolCalls: calls.map((c, i) => ({
      id: `c${loopCount}-${i}`,
      type: 'function' as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
    toolResults: calls.map(() => 'ok'),
  };
}

test('buildReviewPacket extracts filesRead and filesWritten from tool calls', () => {
  const result: AgentResult = {
    text: 'done',
    turns: [
      makeTurn(1, [
        { name: 'read_file', args: { path: 'src/a.ts' } },
        { name: 'read_file', args: { path: 'src/b.ts' } },
      ]),
      makeTurn(2, [
        { name: 'write_file', args: { filePath: 'src/a.ts' } },
        { name: 'edit_file', args: { file_path: 'src/c.ts' } },
      ]),
    ],
    loopCount: 2,
    totalTokens: { prompt: 200, completion: 100 },
    messages: [],
  };

  const packet = buildReviewPacket(result);
  assert.equal(packet.filesRead.length, 2, 'should find 2 files read');
  assert.ok(packet.filesRead.includes('src/a.ts'));
  assert.ok(packet.filesRead.includes('src/b.ts'));
  assert.equal(packet.filesWritten.length, 2, 'should find 2 files written');
  assert.ok(packet.filesWritten.includes('src/a.ts'));
  assert.ok(packet.filesWritten.includes('src/c.ts'));
  assert.equal(packet.totalToolCalls, 4);
  assert.ok(packet.summary.includes('2 turns executed'));
  assert.ok(packet.summary.includes('src/a.ts'));
});

test('buildReviewPacket deduplicates repeated file paths', () => {
  const result: AgentResult = {
    text: 'done',
    turns: [
      makeTurn(1, [
        { name: 'read_file', args: { path: 'src/a.ts' } },
        { name: 'read_file', args: { path: 'src/a.ts' } },
      ]),
    ],
    loopCount: 1,
    totalTokens: { prompt: 100, completion: 50 },
    messages: [],
  };

  const packet = buildReviewPacket(result);
  assert.equal(packet.filesRead.length, 1, 'duplicate paths deduped');
});

test('buildReviewPacket handles empty turns', () => {
  const result: AgentResult = {
    text: 'nothing to do',
    turns: [],
    loopCount: 0,
    totalTokens: { prompt: 10, completion: 5 },
    messages: [],
  };

  const packet = buildReviewPacket(result);
  assert.equal(packet.filesRead.length, 0);
  assert.equal(packet.filesWritten.length, 0);
  assert.equal(packet.totalToolCalls, 0);
  assert.ok(packet.summary.includes('0 turns'));
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

test('confidence default: goalMet=true without explicit confidence fails contract', () => {
  const result = parseSelfCheckResponse(
    JSON.stringify({
      goalMet: true,
      stopConditionsMet: [true],
      summaryOfEvidence: '',
      gaps: [],
    }),
    1,
  );
  assert.equal(result.goalMet, false);
  assert.equal(result.gaps[0].condition, 'self_check_parse');
});

test('confidence default: goalMet=false without explicit confidence fails contract', () => {
  const result = parseSelfCheckResponse(
    JSON.stringify({
      goalMet: false,
      stopConditionsMet: [false],
      summaryOfEvidence: '',
      gaps: [],
    }),
    1,
  );
  assert.equal(result.gaps[0].condition, 'self_check_parse');
});

test('confidence out of [0, 1] range fails contract instead of clamping', () => {
  const high = parseSelfCheckResponse(
    JSON.stringify({ goalMet: true, stopConditionsMet: [], summaryOfEvidence: '', confidence: 2.5, gaps: [] }),
    0,
  );
  assert.equal(high.gaps[0].condition, 'self_check_parse');
  assert.match(high.gaps[0].detail, /confidence must be within \[0, 1\]/);

  const low = parseSelfCheckResponse(
    JSON.stringify({ goalMet: false, stopConditionsMet: [], summaryOfEvidence: '', confidence: -0.5, gaps: [] }),
    0,
  );
  assert.equal(low.gaps[0].condition, 'self_check_parse');
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
