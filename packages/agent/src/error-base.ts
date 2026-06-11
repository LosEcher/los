/**
 * Structured error envelope for the agent package.
 *
 * Replaces plain `throw new Error(string)` with machine-readable error codes,
 * HTTP status mapping, and structured context. Feeding into the diagnostics
 * system (GET /diagnostics/:traceId) and SSE error responses.
 *
 * Error code convention: CATEGORY_SUBCATEGORY
 *   PROVIDER_HTTP_4xx  — provider returned a client error
 *   PROVIDER_HTTP_5xx  — provider returned a server error
 *   PROVIDER_NETWORK    — fetch failed (DNS, connection refused, timeout)
 *   PROVIDER_PARSE      — response body could not be parsed
 *   TOOL_CALL_PARSE     — tool call arguments are not valid JSON
 *   TOOL_EXECUTION      — tool execution failed
 *   AGENT_MAX_LOOPS     — agent hit the loop limit
 *   AGENT_ABORTED       — agent was cancelled
 *   INTERNAL            — unexpected internal error
 */

export interface ErrorContext {
  /** Provider name (e.g. 'packycode', 'deepseek'). */
  provider?: string;
  /** Model identifier used for the request. */
  model?: string;
  /** HTTP status code from the provider response. */
  httpStatus?: number;
  /** Whether the error is retryable (transient). */
  retryable: boolean;
  /** Rate-limit reset time in milliseconds (from Retry-After or x-ratelimit-reset header). */
  rateLimitResetMs?: number;
  /** Tool name for tool-level errors. */
  toolName?: string;
  /** Agent loop turn number. */
  turn?: number;
  /** Original error message from a wrapped cause. */
  causeMessage?: string;
  /** Additional unstructured metadata. */
  [key: string]: unknown;
}

export class AgentError extends Error {
  /** Machine-readable error code (e.g. 'PROVIDER_HTTP_429'). */
  readonly code: string;
  /** Suggested HTTP status for the gateway response. */
  readonly httpStatus: number;
  /** Structured context for diagnostics. */
  readonly context: ErrorContext;

  constructor(code: string, message: string, context: Partial<ErrorContext> = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.httpStatus = context.httpStatus ?? 500;
    this.context = {
      retryable: false,
      ...context,
      causeMessage: context.cause instanceof Error ? context.cause.message : context.causeMessage,
    };
  }

  /** Serialize to a JSON-safe object for SSE error events and diagnostics. */
  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      retryable: this.context.retryable,
    };
    if (this.context.provider) result.provider = this.context.provider;
    if (this.context.model) result.model = this.context.model;
    if (this.context.toolName) result.toolName = this.context.toolName;
    if (this.context.turn !== undefined) result.turn = this.context.turn;
    if (this.context.rateLimitResetMs) result.rateLimitResetMs = this.context.rateLimitResetMs;
    return result;
  }

  /** Build an AgentError from a provider HTTP error response. */
  static fromProviderResponse(
    code: string,
    providerName: string,
    model: string,
    status: number,
    bodyText: string,
    headers?: Headers,
  ): AgentError {
    const retryable = status === 429 || status === 408 || status >= 500;
    const rateLimitResetMs = parseRateLimitReset(headers);
    return new AgentError(code, `${providerName} API error ${status}: ${bodyText.slice(0, 500)}`, {
      provider: providerName,
      model,
      httpStatus: status,
      retryable,
      rateLimitResetMs,
    });
  }
}

function parseRateLimitReset(headers?: Headers): number | undefined {
  if (!headers) return undefined;
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return Date.now() + seconds * 1000;
  }
  const ratelimitReset = headers.get('x-ratelimit-reset');
  if (ratelimitReset) {
    const ms = parseFloat(ratelimitReset) * 1000;
    if (!isNaN(ms)) return ms;
  }
  return undefined;
}
