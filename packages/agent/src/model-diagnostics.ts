import type { Message, ProviderResponse, ToolCall } from './providers/index.js';

export type ModelDiagnosticPhase = 'planning' | 'execution' | 'verification';
export type ModelDiagnosticMode = 'shadow';
export type ModelDiagnosticKind = 'heuristic' | 'j_lens' | 'external';
export type ModelDiagnosticRiskLevel = 'low' | 'medium' | 'high';

export interface ModelDiagnosticConcept {
  token: string;
  rank?: number;
  layer?: number;
  position?: number;
  score?: number;
}

export interface ModelDiagnosticRecommendation {
  type: 'observe' | 'retry' | 'clarify' | 'verify' | 'operator_attention';
  reason: string;
  toolCallIds?: string[];
}

export interface ModelDiagnosticSnapshot {
  kind: ModelDiagnosticKind;
  source: string;
  mode: ModelDiagnosticMode;
  phase: ModelDiagnosticPhase;
  riskLevel: ModelDiagnosticRiskLevel;
  confidence: number;
  scores: {
    uncertainty: number;
    toolArgumentRisk: number;
    completionRisk: number;
    reasoningRisk: number;
  };
  signals: string[];
  concepts?: ModelDiagnosticConcept[];
  recommendations: ModelDiagnosticRecommendation[];
}

export interface ModelDiagnosticInput {
  messages: readonly Message[];
  response: ProviderResponse;
  phase: ModelDiagnosticPhase;
  turn: number;
  provider: string;
  model: string;
  toolCalls: readonly ToolCall[];
}

export interface ModelDiagnosticProbe {
  inspectTurn(input: ModelDiagnosticInput): Promise<ModelDiagnosticSnapshot | null> | ModelDiagnosticSnapshot | null;
}

export interface ModelDiagnosticConfig {
  /** Defaults to true. Set false to remove diagnostics from loop events. */
  enabled?: boolean;
  /** Current runtime behavior is advisory-only. Future modes must not bypass run contracts. */
  mode?: ModelDiagnosticMode;
  /** Optional external probe, for example a local J-lens sidecar adapter. */
  probe?: ModelDiagnosticProbe;
  /** Defaults to true. Disable to use only the external probe. */
  heuristicFallback?: boolean;
  /** Emit tool.preflight_diagnostic even for low-risk calls. Defaults to false. */
  emitLowRiskToolPreflight?: boolean;
}

export interface ToolPreflightDiagnostic {
  mode: ModelDiagnosticMode;
  riskLevel: ModelDiagnosticRiskLevel;
  toolCallCount: number;
  riskyToolCallIds: string[];
  reasons: string[];
  recommendations: ModelDiagnosticRecommendation[];
}

const UNCERTAINTY_PATTERNS: Array<[RegExp, string]> = [
  [/\bnot sure\b/i, 'uncertainty:not_sure'],
  [/\bunsure\b/i, 'uncertainty:unsure'],
  [/\bmaybe\b/i, 'uncertainty:maybe'],
  [/\bmight\b/i, 'uncertainty:might'],
  [/\bunclear\b/i, 'uncertainty:unclear'],
  [/\bunknown\b/i, 'uncertainty:unknown'],
  [/\bcannot determine\b/i, 'uncertainty:cannot_determine'],
  [/\bconfused\b/i, 'uncertainty:confused'],
];

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/\berror\b/i, 'reasoning:error_token'],
  [/\bwrong\b/i, 'reasoning:wrong_token'],
  [/\bincorrect\b/i, 'reasoning:incorrect_token'],
  [/\bfailed\b/i, 'reasoning:failed_token'],
  [/\bmissing\b/i, 'reasoning:missing_token'],
];

export async function resolveModelDiagnosticSnapshot(
  input: ModelDiagnosticInput,
  config: ModelDiagnosticConfig | undefined,
): Promise<ModelDiagnosticSnapshot | undefined> {
  if (config?.enabled === false) return undefined;

  const external = await inspectWithProbe(input, config?.probe);
  if (external) return normalizeSnapshot(external, input.phase);

  if (config?.heuristicFallback === false) return undefined;
  return createHeuristicModelDiagnostic(input);
}

function createHeuristicModelDiagnostic(input: ModelDiagnosticInput): ModelDiagnosticSnapshot {
  const signals: string[] = [];
  const recommendations: ModelDiagnosticRecommendation[] = [];
  const text = `${input.response.text}\n${input.response.reasoningContent ?? ''}`;

  const uncertaintyHits = collectPatternSignals(text, UNCERTAINTY_PATTERNS);
  signals.push(...uncertaintyHits);

  const reasoningHits = collectPatternSignals(text, ERROR_PATTERNS);
  signals.push(...reasoningHits);

  const completionRisk = computeCompletionRisk(input.response, signals);
  const toolRisk = computeToolArgumentRisk(input.toolCalls, signals, recommendations);
  const uncertainty = clamp01(uncertaintyHits.length / 3);
  const reasoningRisk = clamp01(reasoningHits.length / 4);
  const riskScore = Math.max(uncertainty, reasoningRisk, completionRisk, toolRisk);

  if (uncertainty >= 0.5) {
    recommendations.push({
      type: input.phase === 'planning' ? 'clarify' : 'verify',
      reason: 'model output contains multiple uncertainty markers',
    });
  }
  if (completionRisk >= 0.6) {
    recommendations.push({
      type: 'retry',
      reason: 'model response appears truncated or empty',
    });
  }

  return {
    kind: 'heuristic',
    source: 'los.heuristic',
    mode: 'shadow',
    phase: input.phase,
    riskLevel: riskLevelForScore(riskScore),
    confidence: Number(riskScore.toFixed(2)),
    scores: {
      uncertainty: Number(uncertainty.toFixed(2)),
      toolArgumentRisk: Number(toolRisk.toFixed(2)),
      completionRisk: Number(completionRisk.toFixed(2)),
      reasoningRisk: Number(reasoningRisk.toFixed(2)),
    },
    signals: signals.slice(0, 12),
    recommendations: recommendations.slice(0, 6),
  };
}

export function createToolPreflightDiagnostic(
  snapshot: ModelDiagnosticSnapshot | undefined,
  toolCalls: readonly ToolCall[],
): ToolPreflightDiagnostic | undefined {
  if (!snapshot || toolCalls.length === 0) return undefined;
  const riskyToolCallIds = new Set<string>();
  const reasons: string[] = [];

  for (const recommendation of snapshot.recommendations) {
    for (const id of recommendation.toolCallIds ?? []) riskyToolCallIds.add(id);
  }
  for (const signal of snapshot.signals) {
    if (signal.startsWith('tool_args:')) reasons.push(signal);
  }
  if (snapshot.riskLevel !== 'low' && reasons.length === 0) {
    reasons.push(...snapshot.signals.slice(0, 3));
  }

  return {
    mode: snapshot.mode,
    riskLevel: snapshot.riskLevel,
    toolCallCount: toolCalls.length,
    riskyToolCallIds: [...riskyToolCallIds],
    reasons: reasons.slice(0, 8),
    recommendations: snapshot.recommendations
      .filter(item => item.toolCallIds || snapshot.riskLevel !== 'low')
      .slice(0, 6),
  };
}

function collectPatternSignals(text: string, patterns: Array<[RegExp, string]>): string[] {
  const out: string[] = [];
  for (const [pattern, signal] of patterns) {
    if (pattern.test(text)) out.push(signal);
  }
  return out;
}

function computeCompletionRisk(response: ProviderResponse, signals: string[]): number {
  if (response.finishReason === 'length') {
    signals.push('completion:truncated');
    return 0.85;
  }
  if (response.text.trim().length === 0 && response.toolCalls.length === 0) {
    signals.push('completion:empty_response');
    return 0.65;
  }
  return 0;
}

function computeToolArgumentRisk(
  toolCalls: readonly ToolCall[],
  signals: string[],
  recommendations: ModelDiagnosticRecommendation[],
): number {
  let maxRisk = 0;
  for (const call of toolCalls) {
    const args = call.function.arguments.trim();
    if (args.length === 0) {
      maxRisk = Math.max(maxRisk, 0.75);
      signals.push(`tool_args:empty:${call.function.name}`);
      recommendations.push(toolRecommendation(call, 'tool call has empty arguments'));
      continue;
    }
    try {
      const parsed = JSON.parse(args) as unknown;
      if (isEmptyObject(parsed)) {
        maxRisk = Math.max(maxRisk, 0.35);
        signals.push(`tool_args:empty_object:${call.function.name}`);
      }
    } catch {
      maxRisk = Math.max(maxRisk, 0.9);
      signals.push(`tool_args:invalid_json:${call.function.name}`);
      recommendations.push(toolRecommendation(call, 'tool call arguments are not valid JSON'));
    }
    if (call._repair?.repaired) {
      maxRisk = Math.max(maxRisk, 0.5);
      signals.push(`tool_args:provider_repaired:${call.function.name}`);
    }
  }
  return maxRisk;
}

function toolRecommendation(call: ToolCall, reason: string): ModelDiagnosticRecommendation {
  return {
    type: 'verify',
    reason,
    toolCallIds: [call.id],
  };
}

function isEmptyObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

async function inspectWithProbe(
  input: ModelDiagnosticInput,
  probe: ModelDiagnosticProbe | undefined,
): Promise<ModelDiagnosticSnapshot | null> {
  if (!probe) return null;
  try {
    return await probe.inspectTurn(input);
  } catch {
    return null;
  }
}

function normalizeSnapshot(
  snapshot: ModelDiagnosticSnapshot,
  phase: ModelDiagnosticPhase,
): ModelDiagnosticSnapshot {
  return {
    ...snapshot,
    mode: 'shadow',
    phase,
    confidence: clamp01(snapshot.confidence),
    signals: snapshot.signals.slice(0, 24),
    recommendations: snapshot.recommendations.slice(0, 12),
    concepts: snapshot.concepts?.slice(0, 24),
  };
}

function riskLevelForScore(score: number): ModelDiagnosticRiskLevel {
  if (score >= 0.7) return 'high';
  if (score >= 0.35) return 'medium';
  return 'low';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
