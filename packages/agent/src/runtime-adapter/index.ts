/**
 * @los/agent/runtime-adapter/index — Public API surface for runtime adapters.
 */

export {
  startOtelBridge,
  isOtelBridgeRunning,
  type OtelBridgeConfig,
} from './otel-bridge.js';

export {
  spawnClaudeCode,
  runClaudeCodeWithBridge,
  claudeCodeSupportsOtel,
  type ClaudeCodeSpawnInput,
} from './claude-code.js';

export {
  spawnCodex,
  codexSupportsOtel,
  type CodexSpawnInput,
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
