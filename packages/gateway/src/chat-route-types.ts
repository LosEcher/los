import type { ModelSettings } from '@los/agent/model-settings';
import type { RunContractMetadataInput } from '@los/agent';
import type { RunSpecRequest } from '@los/contracts/run-spec';
import type {
  MCPRequestServer,
  SandboxMode,
  ToolMode,
  ToolRetryInput,
} from './chat-normalizers.js';

export type { SandboxMode, ToolMode };

export interface ChatRequestBody {
  prompt: RunSpecRequest['prompt'];
  sessionId?: RunSpecRequest['sessionId'];
  branchFrom?: string;
  branchAtTurn?: number;
  systemPrompt?: string;
  provider?: RunSpecRequest['provider'];
  model?: RunSpecRequest['model'];
  providerFallback?: RunSpecRequest['providerFallback'];
  modelSettings?: ModelSettings;
  projectId?: RunSpecRequest['projectId'];
  workspaceRoot?: RunSpecRequest['workspaceRoot'];
  toolMode?: ToolMode;
  sandboxMode?: SandboxMode;
  allowedTools?: RunSpecRequest['allowedTools'];
  maxLoops?: RunSpecRequest['maxLoops'];
  traceId?: RunSpecRequest['traceId'];
  dedupeKey?: RunSpecRequest['dedupeKey'];
  timeoutMs?: RunSpecRequest['timeoutMs'];
  toolRetry?: ToolRetryInput;
  mcpServers?: MCPRequestServer[];
  runContract?: RunContractMetadataInput;
  persistMemory?: boolean;
  todoId?: string;
  /** Agent identity name for resolution (e.g., 'default', 'child'). */
  identityName?: string;
  /** Agent identity level override. 'none' disables identity injection. */
  identityLevel?: string;
}
