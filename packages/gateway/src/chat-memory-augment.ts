/**
 * Chat route memory augmentation helper.
 * Extracted from chat-route.ts to keep it under the 600-line structure limit.
 */

import {
  routeMemoryRetrieval,
  augmentSystemPrompt,
} from '@los/memory';
import { getDefaultSystemPrompt } from '@los/agent';

/**
 * Augment the system prompt with active procedural rules and task-state memory
 * before passing it to the agent scheduler.
 */
export async function augmentChatSystemPrompt(params: {
  systemPrompt: string | undefined;
  toolMode: string;
  sessionId: string;
  runSpecId: string;
  tenantId?: string;
  projectId?: string;
}): Promise<string> {
  const baseSystemPrompt = params.systemPrompt || getDefaultSystemPrompt(params.toolMode as 'all' | 'project-write' | 'read-only');
  try {
    const retrieval = await routeMemoryRetrieval({
      taskState: 'running',
      sessionId: params.sessionId,
      runSpecId: params.runSpecId,
      tenantId: params.tenantId,
      projectId: params.projectId,
    });
    const augmented = augmentSystemPrompt(baseSystemPrompt, retrieval);
    return augmented.augmentedPrompt;
  } catch {
    // Memory retrieval is best-effort; fall back to base prompt on failure
    return baseSystemPrompt;
  }
}
