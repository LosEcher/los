/**
 * @los/agent/runtime-adapter/types — Shared types for external agent runtime adapters.
 *
 * Each external agent CLI (Claude Code, Codex, Gemini CLI, etc.) is modeled as
 * a RuntimeKind. Adapters normalize their output into los session_events.
 */

export type RuntimeKind = 'claude-code' | 'codex' | 'grok' | 'gemini' | 'aider' | 'opencode' | 'cursor-agent';

export interface RuntimeAdapterConfig {
  kind: RuntimeKind;
  workspaceRoot: string;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  requestId?: string;
  traceId?: string;
  /** OTel endpoint where the agent sends telemetry */
  otelEndpoint?: string;
  /** Timeout for the agent process in ms */
  timeoutMs?: number;
  /** Env vars to pass to the agent process */
  env?: Record<string, string>;
}

export interface RuntimeHandle {
  sessionId: string;
  /** Process handle for the external agent */
  pid: number | undefined;
  /** Kill the agent process */
  kill: (signal?: NodeJS.Signals) => boolean;
  /** Promise that resolves when the agent exits */
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * OTel span attribute keys emitted by Claude Code.
 * @see https://code.claude.com/docs/en/monitoring-usage
 */
export const CLAUDE_CODE_SPAN_NAMES = [
  'claude_code.tool_decision',
  'claude_code.tool_result',
  'claude_code.hook_execution_complete',
  'claude_code.hook_registered',
  'claude_code.mcp_server_connection',
  'claude_code.permission_mode_changed',
  'claude_code.api_request',
  'claude_code.api_response',
  'claude_code.auth',
  'claude_code.plugin_installed',
  'claude_code.plugin_loaded',
  'claude_code.api_error',
  'claude_code.api_retries_exhausted',
  'claude_code.user_prompt',   // when enabled
  'claude_code.session_started',
  'claude_code.session_ended',
] as const;

/** Map Claude Code span names to los event types. */
export function claudeSpanToEventType(spanName: string): string {
  const map: Record<string, string> = {
    'claude_code.tool_decision': 'tool.decision',
    'claude_code.tool_result': 'tool.result',
    'claude_code.hook_execution_complete': 'hook.executed',
    'claude_code.hook_registered': 'hook.registered',
    'claude_code.mcp_server_connection': 'mcp.connection',
    'claude_code.permission_mode_changed': 'permission.changed',
    'claude_code.api_request': 'model.request',
    'claude_code.api_response': 'model.response',
    'claude_code.auth': 'auth',
    'claude_code.plugin_installed': 'plugin.installed',
    'claude_code.plugin_loaded': 'plugin.loaded',
    'claude_code.api_error': 'model.error',
    'claude_code.api_retries_exhausted': 'model.retries_exhausted',
    'claude_code.user_prompt': 'user.prompt',
    'claude_code.session_started': 'session.started',
    'claude_code.session_ended': 'session.completed',
  };
  return map[spanName] ?? spanName.replace(/^claude_code\./, '');
}
