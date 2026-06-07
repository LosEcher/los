import type { ModelSettings } from '@los/agent/model-settings';
import type { RunContractMetadataInput } from '@los/agent';
import type {
  MCPRequestServer,
  ToolMode,
  ToolRetryInput,
} from './chat-normalizers.js';

export interface ChatRequestBody {
  prompt: string;
  sessionId?: string;
  branchFrom?: string;
  branchAtTurn?: number;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  modelSettings?: ModelSettings;
  workspaceRoot?: string;
  toolMode?: ToolMode;
  allowedTools?: string[];
  maxLoops?: number;
  traceId?: string;
  dedupeKey?: string;
  timeoutMs?: number;
  toolRetry?: ToolRetryInput;
  mcpServers?: MCPRequestServer[];
  runContract?: RunContractMetadataInput;
  persistMemory?: boolean;
  todoId?: string;
}
