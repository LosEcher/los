/**
 * @los/agent/runtime-adapter/index — Public API surface for runtime adapters.
 */

export {
  resolveRuntimeCommand,
} from './command.js';

export {
  startOtelBridge,
  isOtelBridgeRunning,
  type OtelBridgeConfig,
} from './otel-bridge.js';

export {
  spawnClaudeCode,
  runClaudeCodeWithBridge,
  claudeCodeAvailable,
  claudeCodeSupportsOtel,
  type ClaudeCodeSpawnInput,
  type ClaudeCodeRuntimeHandle,
  type ClaudeCodeRuntimeOutput,
} from './claude-code.js';

export {
  spawnCodex,
  codexAvailable,
  codexSupportsOtel,
  type CodexSpawnInput,
  type CodexRuntimeHandle,
  type CodexRuntimeOutput,
} from './codex.js';

export {
  spawnGrok,
  getGrokRuntimeModel,
  type GrokSpawnInput,
  type GrokRuntimeHandle,
  type GrokRuntimeOutput,
} from './grok.js';

export {
  claudeSpanToEventType,
  CLAUDE_CODE_SPAN_NAMES,
  type RuntimeKind,
  type RuntimeAdapterConfig,
  type RuntimeHandle,
} from './types.js';
