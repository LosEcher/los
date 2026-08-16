import type { Provider, Message, ToolDef } from './providers/types.js';
import type { AgentResult } from './loop.js';
import type { ModelSettings } from './model-settings.js';
import type { Severity } from './review-runner.js';

export interface SelfCheckGap {
  condition: string;
  detail: string;
  suggestion: string;
  /** Severity of this gap. Defaults to 'warn' when not specified (backward compat). */
  severity?: Severity;
}

export interface SelfCheckInput {
  goal: string;
  stopConditions: string[];
  agentOutput: string;
  contextSummary: string;
  provider: Provider;
  availableTools?: ToolDef[];
  traceId?: string;
  /** Optional custom system prompt for the judge. Falls back to hardcoded evaluator prompt. */
  judgeSystemPrompt?: string;
  /** Model settings for the judge call: limit reasoning/tokens so a
   *  non-streaming self-check does not spend 30-80s generating thousands of
   *  hidden thinking tokens (observed 2026-08-06). */
  modelSettings?: ModelSettings;
  /** Session id for provider-call telemetry attribution (self-check calls
   *  used to land with empty session/trace rows). */
  sessionId?: string;
  /** Hard total timeout for the judge call (ms). Aborts long-tail generation;
   *  the failure is reported as a self_check_timeout gap. Default 60s. */
  timeoutMs?: number;
}

export interface SelfCheckResult {
  goalMet: boolean;
  stopConditionsMet: boolean[];
  summaryOfEvidence: string;
  gaps: SelfCheckGap[];
  selfCheckPassed: boolean;
  /** Judge LLM confidence in its own evaluation (0-1). */
  confidence: number;
  rawResponse: string;
  evaluatedAt: string;
  /** True when the judge call was aborted by the timeout (P1-4). */
  timedOut?: boolean;
  skipped: boolean;
  skipReason?: string;
}

/** Minimum confidence threshold for auto-approval. Below this, operator_attention is triggered. */
export const CONFIDENCE_GATE_THRESHOLD = 0.7;

const MIN_OUTPUT_CHARS = 20;

export async function runPostExecutionSelfCheck(
  input: SelfCheckInput,
): Promise<SelfCheckResult> {
  const now = new Date().toISOString();

  if (!input.agentOutput || input.agentOutput.trim().length < MIN_OUTPUT_CHARS) {
    return {
      goalMet: false,
      stopConditionsMet: input.stopConditions.map(() => false),
      summaryOfEvidence: '',
      gaps: [
        {
          condition: 'output',
          detail: 'agent produced no meaningful output',
          suggestion: 're-run task with adjusted prompt or debug the agent loop',
        },
      ],
      selfCheckPassed: false,
      confidence: 0,
      rawResponse: '',
      evaluatedAt: now,
      skipped: true,
      skipReason: input.agentOutput ? 'output_too_short' : 'empty_output',
    };
  }

  const messages = buildSelfCheckPrompt(input);
  let rawResponse = '';
  let timedOut = false;

  try {
    const timeoutMs = input.timeoutMs ?? 60_000;
    const response = await input.provider.chat(messages, undefined, {
      feature: 'self-check',
      signal: AbortSignal.timeout(timeoutMs),
      traceId: input.traceId,
      sessionId: input.sessionId,
      modelSettings: input.modelSettings,
    });
    rawResponse = response.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // AbortSignal.timeout rejects with DOMException('aborted', 'AbortError')
    // (name 'AbortError', numeric code 20) on some runtimes rather than a
    // TimeoutError; a string code 'ABORT_ERR' also appears. Treat all three
    // shapes as the self-check timeout so the abort path is attributed
    // correctly (2026-08-07: timeout test regressed after PR #208).
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
      || (typeof err === 'object' && err !== null && (
        (err as { name?: string }).name === 'AbortError'
        || (err as { code?: string }).code === 'ABORT_ERR'
      ));
    timedOut = isTimeout;
    return {
      goalMet: false,
      stopConditionsMet: input.stopConditions.map(() => false),
      summaryOfEvidence: '',
      gaps: [
        {
          condition: isTimeout ? 'self_check_timeout' : 'self_check_provider',
          detail: isTimeout
            ? `self-check LLM call timed out after ${input.timeoutMs ?? 60_000}ms`
            : `self-check LLM call failed: ${message}`,
          suggestion: isTimeout
            ? 'verify judge model settings (thinking disabled, maxTokens capped) and retry'
            : 'verify the provider is available and the task result can be reviewed manually',
        },
      ],
      selfCheckPassed: false,
      confidence: 0,
      rawResponse: message,
      evaluatedAt: now,
      skipped: false,
      timedOut,
    };
  }

  const parsed = parseSelfCheckResponse(rawResponse, input.stopConditions.length);
  // stopConditionsMet is audit information (whether the agent stopped because a
  // stop condition fired), NOT a pass gate: tasks that complete normally never
  // trigger a stop condition (e.g. scheduled execution's 'operator cancels
  // schedule'), so requiring every stop condition to be met would fail every
  // well-finished task and trip the circuit breaker.
  const selfCheckPassed = parsed.goalMet;
  return {
    goalMet: parsed.goalMet,
    stopConditionsMet: parsed.stopConditionsMet,
    summaryOfEvidence: parsed.summaryOfEvidence,
    gaps: parsed.gaps,
    selfCheckPassed,
    confidence: parsed.confidence,
    rawResponse,
    evaluatedAt: now,
    skipped: false,
  };
}

export function buildSelfCheckPrompt(input: SelfCheckInput): Message[] {
  const stopConditionsText = input.stopConditions.length > 0
    ? input.stopConditions.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '(none specified)';

  const judgeSystemPrompt = input.judgeSystemPrompt
    ?? 'You are a task evaluator. The agent\'s output may be incomplete or wrong — verify each condition systematically against the evidence.';

  return [
    {
      role: 'system',
      content: judgeSystemPrompt,
    },
    {
      role: 'user',
      content: [
        `Goal: ${input.goal}`,
        '',
        `Stop conditions:`,
        stopConditionsText,
        '',
        `What the agent did:`,
        input.contextSummary,
        '',
        `Agent's final output:`,
        input.agentOutput,
        '',
        [
          'For each stop condition, check whether the agent\'s output provides concrete evidence it was met.',
          'An assertion without evidence is not sufficient.',
          'For any gap, provide a specific suggestion for what to fix.',
        ].join(' '),
        '',
        'Return JSON only:',
        '{',
        '  "goalMet": true/false,',
        '  "stopConditionsMet": [true/false, ...],',
        '  "summaryOfEvidence": "what concrete evidence was found",',
        '  "confidence": 0.0-1.0 (how confident are you in this evaluation?),',
        '  "gaps": [',
        '    {',
        '      "condition": "which condition",',
        '      "detail": "what is missing",',
        '      "suggestion": "what to do about it"',
        '    }',
        '  ]',
        '}',
      ].join('\n'),
    },
  ];
}

interface ParsedSelfCheckResult {
  goalMet: boolean;
  stopConditionsMet: boolean[];
  summaryOfEvidence: string;
  confidence: number;
  gaps: SelfCheckGap[];
}

export interface ValidatedSelfCheckOutput {
  goalMet: boolean;
  stopConditionsMet: boolean[];
  summaryOfEvidence: string;
  confidence: number;
  gaps: SelfCheckGap[];
}

export type SelfCheckValidationResult =
  | { ok: true; output: ValidatedSelfCheckOutput }
  | { ok: false; reason: string };

/**
 * Centralized contract validation for the judge output shape
 * (contracts/self-check-output.yaml). Key fields are strict: a missing or
 * mistyped goalMet/summaryOfEvidence/confidence/gaps fails explicitly instead
 * of silently defaulting (previously a malformed judge response could degrade
 * to a false goalMet=false without an attributable reason). Tolerances kept:
 * stopConditionsMet length mismatches normalize to all-false (models
 * frequently miscount), and the JSON-extraction tolerances live in
 * parseSelfCheckResponse.
 */
export function _validateSelfCheckOutput(
  parsed: unknown,
  expectedStopCount: number,
): SelfCheckValidationResult {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'response is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;

  if (typeof record.goalMet !== 'boolean') {
    return { ok: false, reason: 'goalMet must be a boolean' };
  }
  if (!Array.isArray(record.stopConditionsMet)) {
    return { ok: false, reason: 'stopConditionsMet must be an array' };
  }
  if (!record.stopConditionsMet.every(item => typeof item === 'boolean')) {
    return { ok: false, reason: 'stopConditionsMet entries must be booleans' };
  }
  if (typeof record.summaryOfEvidence !== 'string') {
    return { ok: false, reason: 'summaryOfEvidence must be a string' };
  }
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) {
    return { ok: false, reason: 'confidence must be a finite number' };
  }
  if (record.confidence < 0 || record.confidence > 1) {
    return { ok: false, reason: 'confidence must be within [0, 1]' };
  }
  if (!Array.isArray(record.gaps)) {
    return { ok: false, reason: 'gaps must be an array' };
  }
  const gaps: SelfCheckGap[] = [];
  for (const item of record.gaps) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, reason: 'gaps entries must be objects' };
    }
    const gap = item as Record<string, unknown>;
    if (typeof gap.condition !== 'string' || typeof gap.detail !== 'string' || typeof gap.suggestion !== 'string') {
      return { ok: false, reason: 'gap entries need string condition/detail/suggestion' };
    }
    gaps.push({
      condition: gap.condition.trim(),
      detail: gap.detail.trim(),
      suggestion: gap.suggestion.trim(),
    });
  }

  // Tolerance path: models frequently miscount stop conditions; normalize to
  // all-false rather than failing the whole self-check.
  const stopConditionsMet = record.stopConditionsMet.length === expectedStopCount
    ? record.stopConditionsMet
    : Array(expectedStopCount).fill(false);

  return {
    ok: true,
    output: {
      goalMet: record.goalMet,
      stopConditionsMet,
      summaryOfEvidence: record.summaryOfEvidence.trim(),
      confidence: record.confidence,
      gaps,
    },
  };
}

export function parseSelfCheckResponse(
  text: string,
  expectedStopCount: number,
): ParsedSelfCheckResult {
  const fail = (reason: string): ParsedSelfCheckResult => ({
    goalMet: false,
    stopConditionsMet: Array(expectedStopCount).fill(false),
    summaryOfEvidence: '',
    confidence: 0,
    gaps: [
      {
        condition: 'self_check_parse',
        detail: reason,
        suggestion: 'review the agent output manually and re-run with a corrected contract',
      },
    ],
  });

  if (!text || !text.trim()) {
    return fail('empty self-check response');
  }

  let jsonStr = text.trim();
  // Remove markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Tolerate models that wrap the JSON with tool-call noise (e.g. a
    // hallucinated <tool_calls> prefix): extract the first balanced {...}
    // object instead of failing the whole self-check.
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = jsonStr.slice(start, end + 1);
      try {
        parsed = JSON.parse(candidate);
      } catch {
        parsed = null;
      }
    }
  }

  const validation = _validateSelfCheckOutput(parsed, expectedStopCount);
  if (!validation.ok) {
    return fail(`invalid self-check contract: ${validation.reason}`);
  }

  return validation.output;
}

export function shouldRunSelfCheck(
  contract: { goal?: string; stopConditions?: string[]; selfCheckEnabled?: boolean } | undefined,
): boolean {
  if (!contract) return false;
  if (contract.selfCheckEnabled === false) return false;
  if (!contract.goal && (!contract.stopConditions || contract.stopConditions.length === 0)) return false;
  return true;
}

export function summarizeAgentContext(result: AgentResult): string {
  return buildReviewPacket(result).summary;
}

export interface ReviewPacket {
  /** Human-readable summary for the review prompt. */
  summary: string;
  /** Files that were read during the session (from read_file / search tools). */
  filesRead: string[];
  /** Files that were written or modified (from write_file / edit_file / apply_patch). */
  filesWritten: string[];
  /** Total number of tool calls across all turns. */
  totalToolCalls: number;
}

/**
 * Pre-bake a review packet from the agent's tool calls so the reviewer
 * doesn't need to run git/grep to discover what happened.
 *
 * Inspired by Superpowers 6: pre-generating the review "packet" handed to
 * reviewers cut reviewer token spend by ~10%. The reviewer prompt already
 * receives the full agent output text; this adds the mechanical context
 * (file list, tool call counts) that reviewers would otherwise discover
 * by running git commands. The extraction is zero-cost — it walks tool
 * call metadata already in memory.
 */
export function buildReviewPacket(result: AgentResult): ReviewPacket {
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  let totalToolCalls = 0;

  const READ_TOOLS = new Set(['read_file', 'read_many_files', 'grep', 'search_code', 'list_directory']);
  const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'preview_patch', 'replace_in_file']);

  for (const turn of result.turns) {
    totalToolCalls += turn.toolCalls.length;
    for (const tc of turn.toolCalls) {
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch { /* best-effort */ }

      const path = typeof args.filePath === 'string' ? args.filePath
        : typeof args.path === 'string' ? args.path
        : typeof args.file_path === 'string' ? args.file_path
        : typeof args.target_file === 'string' ? args.target_file
        : undefined;

      if (path) {
        if (WRITE_TOOLS.has(name)) filesWritten.add(path);
        if (READ_TOOLS.has(name)) filesRead.add(path);
      }

      // Also extract from directory read results
      if (name === 'list_directory' && typeof args.path === 'string') {
        filesRead.add(args.path + (args.path.endsWith('/') ? '' : '/'));
      }
    }
  }

  const parts: string[] = [];
  parts.push(`${result.loopCount} turns executed, ${totalToolCalls} tool calls`);
  if (filesRead.size > 0) {
    parts.push(`Files read (${filesRead.size}):\n  ${[...filesRead].sort().join('\n  ')}`);
  }
  if (filesWritten.size > 0) {
    parts.push(`Files written/modified (${filesWritten.size}):\n  ${[...filesWritten].sort().join('\n  ')}`);
  }

  // Append per-turn summary (compact: tool names only, no result content)
  for (const turn of result.turns) {
    const toolNames = turn.toolCalls.map(tc => tc.function.name);
    parts.push(
      `Turn ${turn.loopCount}: tools=[${toolNames.join(', ') || 'none'}]`,
    );
  }

  return {
    summary: parts.join('\n'),
    filesRead: [...filesRead].sort(),
    filesWritten: [...filesWritten].sort(),
    totalToolCalls,
  };
}
