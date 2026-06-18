import type { Provider, Message } from './providers/types.js';

/**
 * Unified severity level shared across the review, governance, and memory packages.
 * - `critical`: Blocks progress — the task must be fixed before continuing.
 * - `error`: Query/infra failure — the check itself could not run.
 * - `warn`: Anomaly detected — should be reviewed but does not block.
 * - `info`: Informational — routine pass or note.
 */
export type Severity = 'critical' | 'error' | 'warn' | 'info';

// ── Review Role Configuration ──────────────────────────────

/** Static configuration for a single review role. */
export interface ReviewRoleConfig {
  /** Unique role name, e.g. "spec-compliance", "code-quality". */
  name: string;
  /** LLM provider to invoke for this role. */
  provider: Provider;
  /** Custom system prompt for this role's review lens. */
  systemPrompt?: string;
  /**
   * Minimum severity that blocks task completion.
   * Findings at or above this level cause the role to fail.
   * Default: 'critical' (only explicit critical findings block).
   */
  blockingSeverity: Severity;
  /** Whether this role is active. Inactive roles are skipped. */
  enabled: boolean;
}

// ── Review Finding ─────────────────────────────────────────

/** A single finding from a review role. */
export interface ReviewFinding {
  /** Severity of this specific finding. */
  severity: Severity;
  /** What condition or dimension was checked. */
  condition: string;
  /** Concrete detail about what was found. */
  detail: string;
  /** Actionable suggestion for how to fix. */
  suggestion: string;
  /** Optional evidence pointer — file path, line number, log excerpt, etc. */
  evidence?: string;
}

// ── Review Results ─────────────────────────────────────────

/** Result from a single review role's evaluation. */
export interface ReviewRoleResult {
  roleName: string;
  /** True if no findings meet or exceed the role's blocking severity. */
  passed: boolean;
  /** All findings from this role (including non-blocking). */
  findings: ReviewFinding[];
  /** Raw LLM response text for audit trail. */
  rawResponse: string;
  /** ISO-8601 timestamp of evaluation. */
  evaluatedAt: string;
  /** True if this role was skipped (not enabled or provider failed). */
  skipped: boolean;
  skipReason?: string;
}

/** Aggregate result from all review roles. */
export interface MultiRoleReviewResult {
  /** Per-role results in the order they were configured. */
  roles: ReviewRoleResult[];
  /** True if ALL enabled roles passed. */
  passed: boolean;
  /** Findings that caused blocking (at or above their role's blocking severity). */
  blockingFindings: ReviewFinding[];
  /** ISO-8601 timestamp of evaluation. */
  evaluatedAt: string;
}

// ── Review Output Shape (what the LLM returns) ─────────────

interface ReviewOutputJson {
  passed: boolean;
  summaryOfEvidence: string;
  findings: Array<{
    severity: string;
    condition: string;
    detail: string;
    suggestion: string;
    evidence?: string;
  }>;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Run all enabled review roles in parallel against an agent's output.
 *
 * Each role evaluates the output through a different lens (spec compliance,
 * code quality, security, etc.) using its own provider and prompt. Findings
 * are classified by severity; roles whose findings meet or exceed their
 * `blockingSeverity` cause the overall review to fail.
 *
 * @param roles  Configured review roles.
 * @param goal   The declared goal from the run contract.
 * @param agentOutput  The agent's final text output.
 * @param contextSummary  Summary of what the agent did (turns, tools).
 * @param traceId  Optional trace ID for provider call diagnostics.
 */
export async function runMultiRoleReview(
  roles: ReviewRoleConfig[],
  goal: string,
  agentOutput: string,
  contextSummary: string,
  traceId?: string,
): Promise<MultiRoleReviewResult> {
  const now = new Date().toISOString();
  const enabledRoles = roles.filter(r => r.enabled);

  if (enabledRoles.length === 0) {
    return {
      roles: [],
      passed: true,
      blockingFindings: [],
      evaluatedAt: now,
    };
  }

  // Run all enabled roles in parallel
  const roleResults = await Promise.all(
    enabledRoles.map(role => runSingleReviewRole(role, goal, agentOutput, contextSummary, traceId)),
  );

  const blockingFindings = extractBlockingFindings(roleResults, enabledRoles);
  const passed = roleResults.every(r => r.passed);

  return {
    roles: roleResults,
    passed,
    blockingFindings,
    evaluatedAt: now,
  };
}

// ── Single Role Evaluation ─────────────────────────────────

async function runSingleReviewRole(
  role: ReviewRoleConfig,
  goal: string,
  agentOutput: string,
  contextSummary: string,
  traceId?: string,
): Promise<ReviewRoleResult> {
  const now = new Date().toISOString();

  // Gate: empty or trivial output
  if (!agentOutput || agentOutput.trim().length < MIN_OUTPUT_CHARS) {
    return {
      roleName: role.name,
      passed: false,
      findings: [{
        severity: 'warn',
        condition: 'output',
        detail: 'agent produced no meaningful output to review',
        suggestion: 're-run task with adjusted prompt or debug the agent loop',
      }],
      rawResponse: '',
      evaluatedAt: now,
      skipped: true,
      skipReason: agentOutput ? 'output_too_short' : 'empty_output',
    };
  }

  const messages = buildReviewPrompt(role, goal, agentOutput, contextSummary);
  let rawResponse = '';

  try {
    const response = await role.provider.chat(messages, undefined, {
      signal: undefined,
      traceId,
    });
    rawResponse = response.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      roleName: role.name,
      passed: false,
      findings: [{
        severity: 'error',
        condition: 'review_provider',
        detail: `review LLM call failed for role "${role.name}": ${message}`,
        suggestion: 'verify the provider is available and review the output manually',
      }],
      rawResponse: message,
      evaluatedAt: now,
      skipped: false,
    };
  }

  const parsed = parseReviewResponse(rawResponse, role);
  const passed = !parsed.findings.some(f => severityRank(f.severity) >= severityRank(role.blockingSeverity));

  return {
    roleName: role.name,
    passed,
    findings: parsed.findings,
    rawResponse,
    evaluatedAt: now,
    skipped: false,
  };
}

// ── Prompt Building ────────────────────────────────────────

const MIN_OUTPUT_CHARS = 20;

/** Default review system prompts per role kind. */
const DEFAULT_PROMPTS: Record<string, string> = {
  'spec-compliance': [
    'You are a specification compliance reviewer.',
    'Your job is to check whether the agent\'s output matches the declared goal and plan.',
    'Focus on:',
    '- Does the output address every part of the goal?',
    '- Are all required deliverables present?',
    '- Is anything from the plan missing or incomplete?',
    '- Is there concrete evidence (not just assertions) for each claim?',
    'Classify each finding by severity:',
    '  critical: A core requirement is completely missing or violated — the task MUST be redone.',
    '  warn: Something is incomplete or weakly evidenced — should be reviewed by a human.',
    '  info: Minor observation, not actionable.',
  ].join('\n'),

  'code-quality': [
    'You are a code quality reviewer.',
    'Your job is to check the correctness, safety, and maintainability of the agent\'s output.',
    'Focus on:',
    '- Are there obvious bugs, logic errors, or edge cases?',
    '- Is error handling adequate for the operations performed?',
    '- Does the code follow project patterns and conventions?',
    '- Are there security concerns (injection, missing validation, exposed secrets)?',
    '- Is the code clear and maintainable?',
    'Classify each finding by severity:',
    '  critical: Bug that would cause incorrect behavior or a security vulnerability — MUST be fixed.',
    '  warn: Code smell, missing error handling, or pattern deviation — should be reviewed.',
    '  info: Style nit, minor suggestion.',
  ].join('\n'),

  'security': [
    'You are a security reviewer.',
    'Your job is to identify security vulnerabilities in the agent\'s output.',
    'Focus on:',
    '- Injection risks (SQL, command, prompt injection)',
    '- Authentication and authorization gaps',
    '- Sensitive data exposure (secrets, PII in logs/output)',
    '- Input validation and sanitization',
    '- Secure defaults and fail-safe behavior',
    'Classify each finding by severity:',
    '  critical: Exploitable vulnerability — MUST be fixed before merge.',
    '  warn: Security weakness or insecure pattern — should be reviewed.',
    '  info: Defense-in-depth suggestion.',
  ].join('\n'),
};

export function buildReviewPrompt(
  role: ReviewRoleConfig,
  goal: string,
  agentOutput: string,
  contextSummary: string,
): Message[] {
  const systemPrompt = role.systemPrompt
    ?? DEFAULT_PROMPTS[role.name]
    ?? `You are a "${role.name}" reviewer. Evaluate the agent's output for correctness, completeness, and quality.`;

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        `Goal: ${goal}`,
        '',
        `What the agent did:`,
        contextSummary,
        '',
        `Agent's final output:`,
        agentOutput,
        '',
        [
          'Review the output through your specific lens.',
          'For each finding, provide concrete evidence (file path, line number, or specific output excerpt).',
          'An assertion without evidence is not sufficient.',
          'If everything looks good, return an empty findings array.',
        ].join(' '),
        '',
        'Return JSON only:',
        '{',
        '  "passed": true/false,',
        '  "summaryOfEvidence": "what concrete evidence was found for or against quality",',
        '  "findings": [',
        '    {',
        '      "severity": "critical|warn|info",',
        '      "condition": "what was checked",',
        '      "detail": "what was found",',
        '      "suggestion": "how to fix",',
        '      "evidence": "file:line or specific excerpt (optional)"',
        '    }',
        '  ]',
        '}',
      ].join('\n'),
    },
  ];
}

// ── Response Parsing ───────────────────────────────────────

function normaliseSeverity(raw: string): Severity {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'error') return 'error';
  if (s === 'warn' || s === 'warning') return 'warn';
  return 'info';
}

export function parseReviewResponse(
  text: string,
  role: { name: string; blockingSeverity: Severity },
): { findings: ReviewFinding[] } {
  const failFinding = (reason: string): ReviewFinding[] => [
    {
      severity: 'error',
      condition: 'review_parse',
      detail: reason,
      suggestion: `review the "${role.name}" output manually`,
    },
  ];

  if (!text || !text.trim()) {
    return { findings: failFinding('empty review response') };
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
    return { findings: failFinding(`unparseable JSON response: ${text.slice(0, 200)}`) };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { findings: failFinding('response is not a JSON object') };
  }

  const findings: ReviewFinding[] = [];
  if (Array.isArray(parsed.findings)) {
    for (const item of parsed.findings) {
      if (item && typeof item === 'object') {
        const severity = normaliseSeverity((item as any).severity);
        findings.push({
          severity,
          condition: typeof (item as any).condition === 'string' ? (item as any).condition.trim() : '',
          detail: typeof (item as any).detail === 'string' ? (item as any).detail.trim() : '',
          suggestion: typeof (item as any).suggestion === 'string' ? (item as any).suggestion.trim() : '',
          evidence: typeof (item as any).evidence === 'string' ? (item as any).evidence.trim() : undefined,
        });
      }
    }
  }

  // If the LLM returned "passed: false" with no findings, add a generic one
  if (parsed.passed === false && findings.length === 0) {
    findings.push({
      severity: 'warn',
      condition: 'review',
      detail: `role "${role.name}" reported failure without specific findings`,
      suggestion: 'review the output manually against the role criteria',
    });
  }

  return { findings };
}

// ── Severity Helpers ───────────────────────────────────────

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
};

/** Numeric rank for severity comparison. Higher = more severe. */
export function severityRank(s: Severity): number {
  return SEVERITY_ORDER[s] ?? 0;
}

/**
 * Severities in increasing order of seriousness.
 * Useful for filtering: `findingsAbove('warn')` returns error + critical.
 */
export const SEVERITY_LEVELS: Severity[] = ['info', 'warn', 'error', 'critical'];

/**
 * Return findings at or above the given threshold.
 */
export function findingsAbove(findings: ReviewFinding[], threshold: Severity): ReviewFinding[] {
  const min = severityRank(threshold);
  return findings.filter(f => severityRank(f.severity) >= min);
}

/** Extract findings that met or exceeded each role's blocking severity. */
function extractBlockingFindings(
  results: ReviewRoleResult[],
  roles: ReviewRoleConfig[],
): ReviewFinding[] {
  const blocking: ReviewFinding[] = [];
  for (const result of results) {
    const role = roles.find(r => r.name === result.roleName);
    if (!role) continue;
    const threshold = severityRank(role.blockingSeverity);
    for (const f of result.findings) {
      if (severityRank(f.severity) >= threshold) {
        blocking.push(f);
      }
    }
  }
  return blocking;
}
