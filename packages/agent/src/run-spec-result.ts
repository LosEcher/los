/**
 * @los/agent/run-spec-result — result_json contract types + validation
 * (contracts/run-spec-result.yaml).
 *
 * Extracted from run-specs.ts to keep that file under the 700-line module
 * gate while the validation stays centralized (shared style with
 * self-check's _validateSelfCheckOutput / contracts/self-check-output.yaml).
 */

export type RunSpecResult = {
  /** 'completed' when the run finished normally, 'failed' when it threw. */
  status: 'completed' | 'failed';
  text: string;
  loopCount?: number;
  totalTokens?: number;
  error?: string;
  completedAt: string;
};

export type RunSpecResultValidation =
  | { ok: true; result: RunSpecResult }
  | { ok: false; reason: string };

/**
 * Centralized contract validation for run_specs.result_json
 * (contracts/run-spec-result.yaml). Strict on the required core (status
 * enum, text string, completedAt string) so a malformed payload can never be
 * persisted silently; optional numeric fields are range-checked when
 * present. The read path keeps normalizeRunSpecResult's tolerant coercion
 * for legacy rows.
 */
export function _validateRunSpecResult(input: unknown): RunSpecResultValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'result must be a JSON object' };
  }
  const record = input as Record<string, unknown>;
  if (record.status !== 'completed' && record.status !== 'failed') {
    return { ok: false, reason: 'status must be "completed" or "failed"' };
  }
  if (typeof record.text !== 'string') {
    return { ok: false, reason: 'text must be a string' };
  }
  if (typeof record.completedAt !== 'string' || Number.isNaN(Date.parse(record.completedAt))) {
    return { ok: false, reason: 'completedAt must be an ISO date-time string' };
  }
  if (record.loopCount !== undefined && (typeof record.loopCount !== 'number' || record.loopCount < 0)) {
    return { ok: false, reason: 'loopCount must be a non-negative number' };
  }
  if (record.totalTokens !== undefined && (typeof record.totalTokens !== 'number' || record.totalTokens < 0)) {
    return { ok: false, reason: 'totalTokens must be a non-negative number' };
  }
  if (record.error !== undefined && typeof record.error !== 'string') {
    return { ok: false, reason: 'error must be a string' };
  }
  return {
    ok: true,
    result: {
      status: record.status,
      text: record.text,
      ...(record.loopCount !== undefined ? { loopCount: record.loopCount } : {}),
      ...(record.totalTokens !== undefined ? { totalTokens: record.totalTokens } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      completedAt: record.completedAt,
    },
  };
}
