import type { Provider, Message, ToolDef } from './providers/types.js';
import type { AgentResult } from './loop.js';
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

  try {
    const response = await input.provider.chat(messages, undefined, {
      signal: undefined,
      traceId: input.traceId,
    });
    rawResponse = response.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      goalMet: false,
      stopConditionsMet: input.stopConditions.map(() => false),
      summaryOfEvidence: '',
      gaps: [
        {
          condition: 'self_check_provider',
          detail: `self-check LLM call failed: ${message}`,
          suggestion: 'verify the provider is available and the task result can be reviewed manually',
        },
      ],
      selfCheckPassed: false,
      confidence: 0,
      rawResponse: message,
      evaluatedAt: now,
      skipped: false,
    };
  }

  const parsed = parseSelfCheckResponse(rawResponse, input.stopConditions.length);
  return {
    goalMet: parsed.goalMet,
    stopConditionsMet: parsed.stopConditionsMet,
    summaryOfEvidence: parsed.summaryOfEvidence,
    gaps: parsed.gaps,
    selfCheckPassed: parsed.goalMet && parsed.stopConditionsMet.every(Boolean),
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

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return fail(`unparseable JSON response: ${text.slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('response is not a JSON object');
  }

  const goalMet = typeof parsed.goalMet === 'boolean' ? parsed.goalMet : false;

  let stopConditionsMet: boolean[];
  if (Array.isArray(parsed.stopConditionsMet)) {
    stopConditionsMet = parsed.stopConditionsMet.map(item => typeof item === 'boolean' ? item : false);
  } else {
    stopConditionsMet = Array(expectedStopCount).fill(false);
  }
  if (stopConditionsMet.length !== expectedStopCount) {
    stopConditionsMet = Array(expectedStopCount).fill(false);
  }

  const summaryOfEvidence = typeof parsed.summaryOfEvidence === 'string'
    ? parsed.summaryOfEvidence.trim()
    : '';

  const gaps: SelfCheckGap[] = [];
  if (Array.isArray(parsed.gaps)) {
    for (const item of parsed.gaps) {
      if (item && typeof item === 'object') {
        gaps.push({
          condition: typeof (item as any).condition === 'string' ? (item as any).condition.trim() : '',
          detail: typeof (item as any).detail === 'string' ? (item as any).detail.trim() : '',
          suggestion: typeof (item as any).suggestion === 'string' ? (item as any).suggestion.trim() : '',
        });
      }
    }
  }

  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : (goalMet ? 0.5 : 0);

  return { goalMet, stopConditionsMet, summaryOfEvidence, confidence, gaps };
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
