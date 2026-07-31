/**
 * @los/agent/loop/stop-conditions — Runtime stop-condition enforcement.
 *
 * When a run contract specifies stop conditions, the agent loop periodically
 * reminds the LLM about them and evaluates whether each condition has been
 * independently addressed. A composite pass requires every condition to be
 * referenced in the response.
 */

// ── Patterns for detecting stop-condition satisfaction ──

const STOP_CONDITION_MET_PATTERNS = [
  /stop\s*conditions?\s*(are\s*)?(all\s*)?met/i,
  /all\s*conditions?\s*satisfied/i,
  /stopping\s*conditions?\s*fulfilled/i,
  /task\s*complete[.,\s]*all\s*conditions?\s*met/i,
  /goal\s*achieved[.,\s]*conditions?\s*met/i,
];

// ── Public API ──────────────────────────────────────────

/**
 * Check if the run contract metadata has non-empty stop conditions.
 */
export function hasStopConditions(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  const sc = metadata.stopConditions;
  return Array.isArray(sc) && sc.length > 0 && sc.some((c: unknown) => typeof c === 'string' && c.trim().length > 0);
}

/**
 * Extract stop conditions from run contract metadata as a string array.
 */
export function getStopConditions(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  const sc = metadata.stopConditions;
  if (!Array.isArray(sc)) return [];
  return sc.filter((c: unknown): c is string => typeof c === 'string' && c.trim().length > 0).map(c => c.trim());
}

/**
 * Build a reminder message for the LLM about pending stop conditions.
 * Requires per-condition confirmation for deterministic evaluation.
 * Returns null if conditions are empty.
 */
export function buildStopConditionReminder(metadata: Record<string, unknown> | undefined): string | null {
  const conditions = getStopConditions(metadata);
  if (conditions.length === 0) return null;

  const list = conditions.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `STOP CONDITION CHECK: Review each condition below and confirm whether it has been met (yes/no) with a one-line summary. If ALL are met, respond with "Stop conditions are all met" followed by the per-condition breakdown. If any are NOT met, continue working.\n\nConditions:\n${list}\n\nRespond with:\n\`\`\`stop-check\n1. [yes/no] <one-line summary>\n2. [yes/no] <one-line summary>\n...\n\`\`\``;
}

/**
 * Check if the LLM's response text declares that stop conditions have been met.
 * Uses explicit declaration patterns as a fast signal. For per-condition
 * evidence use {@link evaluateStopConditions}.
 */
export function checkStopConditionsMet(responseText: string): boolean {
  if (!responseText) return false;
  // Check for explicit declaration patterns
  for (const pattern of STOP_CONDITION_MET_PATTERNS) {
    if (pattern.test(responseText)) return true;
  }
  return false;
}

/**
 * Result of a per-condition stop-condition evaluation.
 */
export interface StopConditionResult {
  /** Whether every condition was independently confirmed. */
  allMet: boolean;
  /** Per-condition evaluation with extracted evidence. */
  conditions: Array<{
    condition: string;
    met: boolean;
    /** The matched fragment from the response, or null if not found. */
    evidence: string | null;
  }>;
  /** Whether the global "all met" declaration was found. */
  declarativeMet: boolean;
}

/**
 * Evaluate each stop condition independently against the LLM's response text.
 *
 * Heuristic: a condition is considered "met" when its key words appear in the
 * response alongside an affirmative indicator (yes, done, complete, passed, etc.).
 * This is a lightweight signal — it is not a separate LLM evaluator call.
 *
 * When the response contains a `stop-check` fenced block, parse the per-condition
 * yes/no declarations. Otherwise fall back to keyword heuristics.
 */
export function evaluateStopConditions(
  responseText: string,
  conditions: string[],
): StopConditionResult {
  if (!responseText || conditions.length === 0) {
    return { allMet: false, conditions: [], declarativeMet: false };
  }
  const declarativeMet = checkStopConditionsMet(responseText);

  // Try to parse a structured stop-check block from the response
  const parsed = parseStopCheckBlock(responseText, conditions);
  if (parsed) return { allMet: parsed.every(c => c.met), conditions: parsed, declarativeMet };

  // Fallback: keyword-based per-condition heuristic
  const normalized = responseText.toLowerCase();
  const evaluated = conditions.map(condition => {
    const keywords = extractKeywords(condition);
    const found = keywords.some(kw => normalized.includes(kw));
    const hasAffirmative = AFFIRMATIVE_WORDS.some(w => normalized.includes(w));
    const met = found && hasAffirmative;
    return {
      condition,
      met,
      evidence: found ? `keywords matched: ${keywords.filter(kw => normalized.includes(kw)).join(', ')}` : null,
    };
  });
  return { allMet: declarativeMet && evaluated.every(c => c.met), conditions: evaluated, declarativeMet };
}

// ── Helpers ─────────────────────────────────────────────

const AFFIRMATIVE_WORDS = ['yes', 'done', 'complete', 'completed', 'met', 'satisfied', 'passed', 'finished', 'achieved'];

function extractKeywords(condition: string): string[] {
  return condition.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2)
    .slice(0, 6); // first 6 meaningful words as search keys
}

function parseStopCheckBlock(
  text: string,
  conditions: string[],
): StopConditionResult['conditions'] | null {
  const match = text.match(/```stop-check\s*\n([\s\S]*?)```/i);
  if (!match) return null;
  const lines = match[1]!.split('\n').filter(l => l.trim());
  if (lines.length === 0 || lines.length !== conditions.length) return null;

  return lines.map((line, i) => {
    const trimmed = line.replace(/^\d+\.\s*/, '').trim();
    const isYes = /^\s*\[?yes\]?/i.test(trimmed) || /^\s*✓/.test(trimmed) || trimmed.toLowerCase().startsWith('yes');
    const isNo = /^\s*\[?no\]?/i.test(trimmed) || /^\s*✗/.test(trimmed) || trimmed.toLowerCase().startsWith('no');
    const met = isYes && !isNo;
    return { condition: conditions[i] ?? trimmed, met, evidence: trimmed || null };
  });
}
