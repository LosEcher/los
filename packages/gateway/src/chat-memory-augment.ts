/**
 * Chat route memory augmentation helper.
 * Extracted from chat-route.ts to keep it under the 600-line structure limit.
 *
 * Now also handles agent identity injection (Phase 0 of Agent Identity Decision Framework).
 * Identity block is prepended before the base system prompt; memory augmentation
 * is appended after.
 *
 * Prompt composition chain:
 *   identity block → base system prompt → procedural rules → memory observations
 */

import {
  routeMemoryRetrieval,
  augmentSystemPrompt,
} from '@los/memory';
import {
  getDefaultSystemPrompt,
  resolveAgentIdentity,
  formatIdentityForPrompt,
  type IdentityLevel,
} from '@los/agent';
import { getConfig } from '@los/infra/config';

/**
 * Augment the system prompt with agent identity and task-state memory
 * before passing it to the agent scheduler.
 */
export async function augmentChatSystemPrompt(params: {
  systemPrompt: string | undefined;
  toolMode: string;
  sessionId: string;
  runSpecId: string;
  tenantId?: string;
  projectId?: string;
  /** Agent name for identity resolution (e.g., 'default', 'child'). Default: 'default'. */
  agentIdentity?: string;
  /** Override identity level. Default: 'standard' for gateway chat. */
  identityLevel?: IdentityLevel;
  /** Workspace root for project-level identity file resolution. */
  workspaceRoot?: string;
}): Promise<string> {
  // ── Resolve base system prompt ─────────────────────────
  // Priority: API body → config.agent.systemPrompt (dead wire → now live) → hardcoded default
  let configSystemPrompt: string | undefined;
  try {
    configSystemPrompt = getConfig().agent.systemPrompt;
  } catch {
    // Config not loaded yet — fall through to default
  }

  const baseSystemPrompt =
    params.systemPrompt
    || configSystemPrompt
    || getDefaultSystemPrompt(params.toolMode as 'all' | 'project-write' | 'read-only');

  // ── Agent identity injection (Phase 0) ─────────────────
  let identityBlock = '';
  const agentName = params.agentIdentity ?? 'default';
  const identityLevel = params.identityLevel ?? 'standard';

  if (identityLevel !== 'none') {
    try {
      const workspaceRoot = params.workspaceRoot ?? process.cwd();
      const identity = resolveAgentIdentity(agentName, workspaceRoot);
      identityBlock = formatIdentityForPrompt(identity, identityLevel);
    } catch {
      // Identity resolution is best-effort; proceed without identity block
    }
  }

  // ── Memory augmentation ────────────────────────────────
  try {
    const retrieval = await routeMemoryRetrieval({
      taskState: 'running',
      sessionId: params.sessionId,
      runSpecId: params.runSpecId,
      tenantId: params.tenantId,
      projectId: params.projectId,
    });
    const augmented = augmentSystemPrompt(baseSystemPrompt, retrieval);

    // Compose: identity block → augmented prompt (base + memory)
    if (identityBlock) {
      return identityBlock + '\n\n' + augmented.augmentedPrompt;
    }
    return augmented.augmentedPrompt;
  } catch {
    // Memory retrieval is best-effort; fall back to base prompt + identity
    if (identityBlock) {
      return identityBlock + '\n\n' + baseSystemPrompt;
    }
    return baseSystemPrompt;
  }
}
