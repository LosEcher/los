/**
 * @los/agent/eval-runner — Lightweight eval harness for agent loop changes.
 *
 * Inspired by superpowers-evals: run fixed task scenarios through the agent
 * loop with a deterministic mock provider, then capture token cost, turn count,
 * and success/failure metrics. No real API calls — the mock speaks from a
 * response script. This lets you compare "before" and "after" metrics when
 * changing the loop, spec injection, or compression.
 *
 * The harness is zero-dependency beyond node:test and the agent loop itself.
 * No database, no network. Run with:
 *   pnpm --filter @los/agent test -- --test-name-pattern="eval"
 */

import type {
  AgentResult,
} from './loop/types.js';
import type {
  Provider, ProviderResponse, Message, ToolCall,
} from './providers/index.js';
import type { ModelProfile } from './model-profiles.js';
import type { ModelSettings } from './model-settings.js';
import { estimateTokens, estimateMessageTokens } from './loop/token-utils.js';

// ── Mock Provider ──────────────────────────────────────────

export interface MockTurn {
  /** Text response for this turn. */
  text: string;
  /** Optional tool calls to return. */
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Optional reasoning content (simulates thinking). */
  reasoning?: string;
  /** Provider-reported usage for this turn. */
  usage?: { promptTokens?: number; completionTokens?: number };
  /** Delay in ms to simulate real latency (0 = instant). */
  delayMs?: number;
}

export interface MockProviderOptions {
  script: MockTurn[];
  model?: string;
  profile?: Partial<ModelProfile>;
}

/**
 * A deterministic Provider that returns pre-scripted responses.
 * Turn N returns script[N]; turns beyond the script length repeat the last entry.
 * Each turn reports realistic usage numbers computed from actual message content.
 */
export function createMockProvider(opts: MockProviderOptions): Provider {
  let turn = 0;
  const script = opts.script;
  const model = opts.model ?? 'mock-model';
  const profile: ModelProfile = {
    provider: 'mock',
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl: 'mock://localhost',
    model,
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: true,
    supportsToolStreaming: true,
    sessionAffinity: 'none',
    cachePolicy: 'none',
    toolCallRepair: 'none',
    maxInputTokens: 200_000,
    maxOutputTokens: 16_384,
    usageMapping: {
      promptTokens: ['usage.prompt_tokens'],
      completionTokens: ['usage.completion_tokens'],
      cacheHitTokens: ['usage.cache_read_input_tokens'],
      cacheMissTokens: ['usage.cache_creation_input_tokens'],
      totalTokens: ['usage.total_tokens'],
    },
    retryPolicy: { retryableStatusCodes: [429, 500, 502, 503] },
    knownFailurePatterns: [],
    transportHints: ['http-stream'],
  };

  return {
    name: 'mock',
    profile,
    async chat(
      messages: Message[],
      _tools?: unknown[],
      _options?: unknown,
    ): Promise<ProviderResponse> {
      const entry = script[Math.min(turn, script.length - 1)];
      if (!entry) {
        throw new Error('MockProvider script is empty');
      }
      turn++;

      // Simulate latency if specified
      if (entry.delayMs) {
        await new Promise(r => setTimeout(r, entry.delayMs));
      }

      const toolCalls: ToolCall[] = (entry.toolCalls ?? []).map((tc, idx) => ({
        id: `mock-call-${turn}-${idx}`,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.args),
        },
      }));

      // Compute realistic usage from actual message content + response text
      let promptTokens = entry.usage?.promptTokens ?? 0;
      let completionTokens = entry.usage?.completionTokens ?? 0;
      if (!entry.usage) {
        for (const msg of messages) {
          promptTokens += estimateMessageTokens(msg);
        }
        completionTokens = estimateTokens(entry.text);
        if (entry.reasoning) {
          completionTokens += estimateTokens(entry.reasoning);
        }
      }

      return {
        text: entry.text,
        toolCalls,
        reasoningContent: entry.reasoning,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        model,
      };
    },
  };
}

// ── Eval Scenario ──────────────────────────────────────────

export interface EvalScenario {
  id: string;
  description: string;
  /** Prompt for the agent. */
  prompt: string;
  /** System message injected before the prompt. */
  system?: string;
  /** Expected tool calls across all turns. */
  expectedTools?: string[];
  /** Max loops for this scenario. */
  maxLoops?: number;
}

export interface EvalMetrics {
  scenarioId: string;
  description: string;
  passed: boolean;
  failures: string[];
  turns: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** Estimated token count of all messages at loop exit. */
  estimatedMessageTokens: number;
  /** Total estimated cost (prompt + completion, rough). */
  estimatedTotalTokens: number;
  /** Whether the run completed naturally (no forced summary / maxLoops). */
  completed: boolean;
  /** Duration in ms. */
  durationMs: number;
}

// ── Eval Runner ────────────────────────────────────────────

export interface EvalRunOptions {
  scenarios: EvalScenario[];
  /** Human-readable label for this run (e.g. "baseline", "terse-review-experiment"). */
  label: string;
  /** Optional hook to modify the runner between scenarios (e.g. change spec injection). */
  onBeforeScenario?: (scenario: EvalScenario, index: number) => void;
}

/**
 * Run a set of eval scenarios and collect metrics. Each scenario gets
 * a fresh MockProvider — no shared state.
 * Returns metrics so the caller can diff against a baseline.
 */
export async function runEvalScenarios(
  _opts: EvalRunOptions,
): Promise<EvalMetrics[]> {
  // The actual runAgent integration requires the full setup pipeline.
  // This is a metrics-collection shell: individual scenarios wire their own
  // mock providers by importing runAgent and passing the mock as config.provider.
  //
  // For now, provide the collection infra; scenarios run via the test file.
  throw new Error(
    'runEvalScenarios is a collector shell. Use createMockProvider() with ' +
    'runAgent(config) directly in test files for now. The shell will be ' +
    'filled in when we stabilize the eval scenario format.',
  );
}

// ── Metrics Helpers ────────────────────────────────────────

/**
 * Compute a diff between two eval runs (e.g. baseline vs experiment).
 * Positive percentage = increase from before to after.
 */
export function diffEvalMetrics(before: EvalMetrics[], after: EvalMetrics[]): {
  scenarioId: string;
  tokenDiff: number;
  tokenDiffPct: number;
  turnDiff: number;
  msgTokenDiff: number;
  msgTokenDiffPct: number;
}[] {
  const beforeMap = new Map(before.map(m => [m.scenarioId, m]));
  const diffs: ReturnType<typeof diffEvalMetrics> = [];

  for (const afterMetric of after) {
    const beforeMetric = beforeMap.get(afterMetric.scenarioId);
    if (!beforeMetric) continue;

    const tokenDiff = afterMetric.estimatedTotalTokens - beforeMetric.estimatedTotalTokens;
    const msgTokenDiff = afterMetric.estimatedMessageTokens - beforeMetric.estimatedMessageTokens;

    diffs.push({
      scenarioId: afterMetric.scenarioId,
      tokenDiff,
      tokenDiffPct: beforeMetric.estimatedTotalTokens > 0
        ? (tokenDiff / beforeMetric.estimatedTotalTokens) * 100
        : 0,
      turnDiff: afterMetric.turns - beforeMetric.turns,
      msgTokenDiff,
      msgTokenDiffPct: beforeMetric.estimatedMessageTokens > 0
        ? (msgTokenDiff / beforeMetric.estimatedMessageTokens) * 100
        : 0,
    });
  }

  return diffs;
}

/**
 * Format a metrics report for human consumption.
 */
export function formatEvalReport(metrics: EvalMetrics[], label: string): string {
  const lines = [
    `\n=== Eval Report: ${label} ===`,
    `Scenarios: ${metrics.length}`,
    `Passed: ${metrics.filter(m => m.passed).length}/${metrics.length}`,
    '',
  ];

  for (const m of metrics) {
    const status = m.passed ? '✅' : '❌';
    lines.push(
      `${status} ${m.scenarioId}: ${m.turns}t ${m.estimatedTotalTokens}tk ${m.durationMs}ms` +
      (m.failures.length > 0 ? ` [${m.failures.join(', ')}]` : ''),
    );
  }

  const totalTokens = metrics.reduce((s, m) => s + m.estimatedTotalTokens, 0);
  const totalTurns = metrics.reduce((s, m) => s + m.turns, 0);
  const totalMs = metrics.reduce((s, m) => s + m.durationMs, 0);
  lines.push(
    '',
    `Total: ${totalTokens} tokens, ${totalTurns} turns, ${totalMs}ms`,
  );

  return lines.join('\n');
}
