/**
 * @los/agent/loop/stop-conditions — Runtime stop-condition enforcement.
 *
 * When a run contract specifies stop conditions, the agent loop periodically
 * reminds the LLM about them and checks if the LLM has declared them met.
 * This provides a lightweight runtime gate without additional LLM calls.
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
 * Returns null if conditions are empty.
 */
export function buildStopConditionReminder(metadata: Record<string, unknown> | undefined): string | null {
  const conditions = getStopConditions(metadata);
  if (conditions.length === 0) return null;

  const list = conditions.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `STOP CONDITION CHECK: Review the following stop conditions and confirm whether they have ALL been met. If they have, respond with "Stop conditions are all met" followed by a brief summary. If not, continue working.\n\n${list}`;
}

/**
 * Check if the LLM's response text declares that stop conditions have been met.
 */
export function checkStopConditionsMet(responseText: string): boolean {
  if (!responseText) return false;
  // Check for explicit declaration patterns
  for (const pattern of STOP_CONDITION_MET_PATTERNS) {
    if (pattern.test(responseText)) return true;
  }
  return false;
}
