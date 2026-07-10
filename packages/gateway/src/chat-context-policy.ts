import { appendSessionEvent, type SessionEventRecord } from '@los/agent/session-events';
import type { IdentityLevel } from '@los/agent';
import {
  augmentChatSystemPrompt,
  type ChatContextPolicyDecision,
} from './chat-memory-augment.js';

export interface PrepareChatContextPolicyInput {
  sessionId: string;
  runSpecId: string;
  tenantId: string;
  projectId: string;
  userId: string;
  requestId: string;
  traceId: string;
  workspaceRoot: string;
  toolMode: string;
  systemPrompt?: string;
  identityName?: string;
  identityLevel?: IdentityLevel;
}

export interface PreparedChatContextPolicy {
  systemPrompt: string;
  policy: ChatContextPolicyDecision;
  event: SessionEventRecord;
}

export async function prepareChatContextPolicy(
  input: PrepareChatContextPolicyInput,
): Promise<PreparedChatContextPolicy> {
  const augmented = await augmentChatSystemPrompt({
    systemPrompt: input.systemPrompt,
    toolMode: input.toolMode,
    sessionId: input.sessionId,
    runSpecId: input.runSpecId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    agentIdentity: input.identityName,
    identityLevel: input.identityLevel,
    workspaceRoot: input.workspaceRoot,
  });
  const event = await appendSessionEvent({
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    userId: input.userId,
    requestId: input.requestId,
    traceId: input.traceId,
    type: 'coordinator.context_policy_selected',
    source: 'coordinator',
    payload: {
      runSpecId: input.runSpecId,
      ownerRepo: input.projectId,
      workspaceRoot: input.workspaceRoot,
      baseSystemPromptSource: augmented.policy.baseSystemPromptSource,
      identityName: augmented.policy.identity.name,
      identityLevel: augmented.policy.identity.level,
      identityInjected: augmented.policy.identity.injected,
      memoryStatus: augmented.policy.memory.status,
      memoryLayers: augmented.policy.memory.queriedLayers,
      activeRuleCount: augmented.policy.memory.activeRuleCount,
      observationCount: augmented.policy.memory.observationCount,
      codeGraphEnabled: augmented.policy.codeGraph.enabled,
      codeGraphSelected: augmented.policy.codeGraph.selected,
      codeGraphInjected: augmented.policy.codeGraph.injected,
    },
  });
  return { systemPrompt: augmented.systemPrompt, policy: augmented.policy, event };
}
