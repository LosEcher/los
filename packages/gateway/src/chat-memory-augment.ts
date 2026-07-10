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
  type MemoryLayer,
} from '@los/memory';
import {
  getDefaultSystemPrompt,
  resolveAgentIdentity,
  formatIdentityForPrompt,
  type IdentityLevel,
} from '@los/agent';
import { getConfig } from '@los/infra/config';
import {
  buildCodeStructureBlock,
  shouldInjectThisSession,
} from './chat-cbm-inject.js';

export type BaseSystemPromptSource = 'request' | 'config' | 'default';
export type MemoryContextStatus = 'applied' | 'not_applied' | 'fallback';

export interface ChatContextPolicyDecision {
  baseSystemPromptSource: BaseSystemPromptSource;
  identity: {
    name: string;
    level: IdentityLevel;
    injected: boolean;
  };
  memory: {
    status: MemoryContextStatus;
    queriedLayers: MemoryLayer[];
    activeRuleCount: number;
    observationCount: number;
  };
  codeGraph: {
    enabled: boolean;
    selected: boolean;
    injected: boolean;
  };
}

export interface AugmentedChatSystemPrompt {
  systemPrompt: string;
  policy: ChatContextPolicyDecision;
}

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
}): Promise<AugmentedChatSystemPrompt> {
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
  const baseSystemPromptSource: BaseSystemPromptSource = params.systemPrompt
    ? 'request'
    : configSystemPrompt ? 'config' : 'default';

  // ── Agent identity injection (Phase 0) ─────────────────
  let identityBlock = '';
  const agentName = params.agentIdentity ?? 'default';
  const identityLevel = params.identityLevel ?? 'standard';
  const codeGraph = (() => {
    try {
      return getConfig().memory?.codeGraph;
    } catch {
      return undefined;
    }
  })();
  const codeGraphEnabled = codeGraph?.enabled === true;
  let codeGraphSelected = false;
  let codeGraphInjected = false;

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
    const activeRuleCount = retrieval.activeRules.length;
    const observationCount = Object.values(retrieval.observationsByLayer)
      .reduce((count, observations) => count + observations.length, 0);

    // ── Phase 2: CBM code structure injection (A/B alternating) ──
    let promptWithCode = augmented.augmentedPrompt;
    codeGraphSelected = codeGraphEnabled
      && codeGraph?.injectArchitecture === true
      && shouldInjectThisSession();
    if (codeGraphSelected) {
      const codeBlock = await buildCodeStructureBlock(
        params.systemPrompt ?? '',
        params.workspaceRoot ?? process.cwd(),
        codeGraph?.maxPromptTokens ?? 400,
      );
      if (codeBlock) {
        promptWithCode = augmented.augmentedPrompt + '\n\n' + codeBlock;
        codeGraphInjected = true;
      }
    }

    // Compose: identity block → augmented prompt (base + memory + code context)
    return buildResult(
      identityBlock ? identityBlock + '\n\n' + promptWithCode : promptWithCode,
      {
        status: activeRuleCount + observationCount > 0 ? 'applied' : 'not_applied',
        queriedLayers: retrieval.queriedLayers,
        activeRuleCount,
        observationCount,
      },
    );
  } catch {
    // Memory retrieval is best-effort; fall back to base prompt + identity
    return buildResult(
      identityBlock ? identityBlock + '\n\n' + baseSystemPrompt : baseSystemPrompt,
      { status: 'fallback', queriedLayers: [], activeRuleCount: 0, observationCount: 0 },
    );
  }

  function buildResult(
    systemPrompt: string,
    memory: ChatContextPolicyDecision['memory'],
  ): AugmentedChatSystemPrompt {
    return {
      systemPrompt,
      policy: {
        baseSystemPromptSource,
        identity: { name: agentName, level: identityLevel, injected: Boolean(identityBlock) },
        memory,
        codeGraph: {
          enabled: codeGraphEnabled,
          selected: codeGraphSelected,
          injected: codeGraphInjected,
        },
      },
    };
  }
}
