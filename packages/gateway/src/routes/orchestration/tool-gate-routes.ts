/**
 * @los/gateway tool-gate-routes — PreToolUse hook endpoint for external agents.
 *
 * External agent CLIs (Claude Code, Codex, etc.) POST to /operator/tool-gate
 * before executing each tool. The los policy engine evaluates the request
 * and returns { allowed, reason, warnings }.
 *
 * This gives los bidirectional control: it can observe AND intervene in
 * external agent tool execution.
 *
 * Architecture:
 *   External Agent (PreToolUse hook) → POST /operator/tool-gate
 *       → los policy engine (tool-resolver + pre-action-gate)
 *       → { allowed: true/false, reason, warnings }
 *       → Agent acts on the decision
 *       → Decision is recorded as a session_event for audit
 */

import type { FastifyInstance } from 'fastify';
import {
  createPreActionFailureEvidence,
  loadPreActionEvidence,
  preActionGate,
  type PreActionCheck,
  type PreActionGateConfig,
} from '@los/agent';
import { _GLOBAL_PRE_ACTION_SESSION_ID } from '@los/agent/pre-action-evidence';
import { appendSessionEvent } from '@los/agent/session-events';
import { getLogger } from '@los/infra/logger';

const log = getLogger('tool-gate');

// ── Types ──────────────────────────────────────────────────────────

interface ToolGateRequest {
  /** Unique tool call ID from the agent (e.g. Claude Code's call_id) */
  callId: string;
  /** Tool name (e.g. "Bash", "Write", "Read") */
  toolName: string;
  /** Tool arguments */
  args: Record<string, unknown>;
  /** The session this tool call belongs to */
  sessionId: string;
  /** Optional trace context */
  traceId?: string;
  /** Agent kind */
  source?: string;
  tenantId?: string;
  projectId?: string;
  /** The risk level the agent itself assigned */
  agentRiskLevel?: 'L0' | 'L1' | 'L2';
  /** Previous attempt count if this is a retry */
  attempt?: number;
}

interface ToolGateResponse {
  /** Whether the tool call is allowed to proceed */
  allowed: boolean;
  /** Reason for denial (only present when allowed=false) */
  reason?: string;
  /** Machine-readable reason code */
  reasonCode?: string;
  /** Advisory warnings (always present, even when allowed) */
  warnings: string[];
  /** Whether this matches a known failure pattern */
  knownFailure: boolean;
  /** Flagged fragile file paths */
  flaggedFiles: string[];
  /** Los session event ID for audit trail */
  auditEventId?: number;
}

// ── Gate logic ──────────────────────────────────────────────────────

/** High-risk tool patterns that always require operator approval. */
const ALWAYS_BLOCK_TOOL_PATTERNS: Array<{
  tool: string;
  argPattern: RegExp;
  reasonCode: string;
  reason: string;
}> = [
  {
    tool: 'Bash',
    argPattern: /rm\s+-rf\s+\//i,
    reasonCode: 'destructive_filesystem_root',
    reason: 'Recursive root filesystem deletion is blocked',
  },
  {
    tool: 'Bash',
    argPattern: />\s*\/etc\//i,
    reasonCode: 'system_config_write',
    reason: 'Writing to /etc is blocked — use configuration management',
  },
  {
    tool: 'Bash',
    argPattern: /curl.*\|\s*(ba)?sh/i,
    reasonCode: 'curl_pipe_shell',
    reason: 'curl-pipe-shell pattern is blocked — review the script first',
  },
  {
    tool: 'Bash',
    argPattern: /git\s+push\s+.*--force/i,
    reasonCode: 'force_push',
    reason: 'Force push requires operator approval',
  },
  {
    tool: 'Bash',
    argPattern: /npm\s+publish|pnpm\s+publish|yarn\s+publish/i,
    reasonCode: 'package_publish',
    reason: 'Package publishing requires operator approval',
  },
  {
    tool: 'Bash',
    argPattern: /docker\s+(rm|system\s+prune|volume\s+rm)/i,
    reasonCode: 'docker_destructive',
    reason: 'Docker destructive operations require operator approval',
  },
];

async function evaluateToolGate(req: ToolGateRequest): Promise<ToolGateResponse> {
  const { callId, toolName, args, sessionId, source = 'external-agent' } = req;

  // 1. Check always-block patterns
  for (const pattern of ALWAYS_BLOCK_TOOL_PATTERNS) {
    if (pattern.tool === toolName || pattern.tool === '*') {
      const argString = toolName === 'Bash' && typeof args.command === 'string'
        ? args.command
        : JSON.stringify(args);
      if (pattern.argPattern.test(argString)) {
        return {
          allowed: false,
          reason: pattern.reason,
          reasonCode: pattern.reasonCode,
          warnings: [pattern.reason],
          knownFailure: false,
          flaggedFiles: [],
        };
      }
    }
  }

  // 2. Run pre-action gate (fragile files, known failures, sibling warnings)
  let gateConfig: PreActionGateConfig;
  let evidenceWarning: string | undefined;
  try {
    gateConfig = await loadPreActionEvidence({
      sessionId,
      tenantId: req.tenantId,
      projectId: req.projectId,
    });
  } catch (err) {
    evidenceWarning = 'Persisted pre-action evidence is temporarily unavailable; advisory checks were skipped.';
    log.warn(`${evidenceWarning} ${(err as Error).message}`);
    gateConfig = {};
  }
  const preCheck: PreActionCheck = preActionGate(toolName, args, gateConfig);

  return {
    allowed: true,
    warnings: evidenceWarning ? [evidenceWarning, ...preCheck.warnings] : preCheck.warnings,
    knownFailure: preCheck.knownFailure,
    flaggedFiles: preCheck.flaggedFiles,
  };
}

// ── Routes ──────────────────────────────────────────────────────────

export function registerToolGateRoutes(app: FastifyInstance): void {

  // ── PreToolUse gate ────────────────────────────────────
  app.post('/operator/tool-gate', async (req, reply) => {
    const body = (req.body ?? {}) as ToolGateRequest;

    if (!body.callId || !body.toolName) {
      return reply.status(400).send({
        allowed: false,
        reason: 'callId and toolName are required',
        reasonCode: 'invalid_request',
        warnings: [],
        knownFailure: false,
        flaggedFiles: [],
      });
    }

    const decision = await evaluateToolGate(body);

    // Record decision as session event for audit
    let auditEventId: number | undefined;
    if (body.sessionId) {
      try {
        const event = await appendSessionEvent({
          sessionId: body.sessionId,
          type: decision.allowed ? 'tool.gate.allow' : 'tool.gate.deny',
          source: body.source ?? 'tool-gate',
          traceId: body.traceId,
          toolName: body.toolName,
          payload: {
            callId: body.callId,
            args: body.args,
            allowed: decision.allowed,
            reasonCode: decision.reasonCode ?? null,
            reason: decision.reason ?? null,
            warnings: decision.warnings,
            knownFailure: decision.knownFailure,
            flaggedFiles: decision.flaggedFiles,
          },
        });
        auditEventId = event.id;
      } catch (err) {
        log.warn(`Failed to record tool-gate event: ${(err as Error).message}`);
      }
    }

    if (!decision.allowed) {
      log.warn(`Tool gate DENIED: ${body.toolName} callId=${body.callId} reason=${decision.reasonCode}`);
    }

    return reply.status(decision.allowed ? 200 : 403).send({
      ...decision,
      auditEventId,
    });
  });

  // ── PostToolUse feedback ───────────────────────────────
  // Agent reports tool execution result so los can learn failure patterns.
  app.post('/operator/tool-feedback', async (req, reply) => {
    const body = (req.body ?? {}) as {
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      ok: boolean;
      error?: string;
      sessionId: string;
      traceId?: string;
      source?: string;
      tenantId?: string;
      projectId?: string;
    };

    if (!body.callId || !body.toolName || !body.sessionId) {
      return reply.status(400).send({ error: 'callId, toolName, and sessionId are required' });
    }

    const failureEvidence = !body.ok && body.error
      ? createPreActionFailureEvidence(body.toolName, body.args, body.error, body.callId)
      : undefined;
    await appendSessionEvent({
      sessionId: body.sessionId,
      tenantId: body.tenantId,
      projectId: body.projectId,
      type: failureEvidence ? 'tool.pre_action.failure' : 'tool.gate.feedback.ok',
      source: body.source ?? 'tool-gate',
      traceId: body.traceId,
      toolName: body.toolName,
      payload: failureEvidence ? { ...failureEvidence } : {
        callId: body.callId,
        args: body.args,
        ok: body.ok,
      },
    });
    const evidence = await loadPreActionEvidence({
      sessionId: body.sessionId,
      tenantId: body.tenantId,
      projectId: body.projectId,
    });

    return reply.send({
      recorded: true,
      fragileFiles: evidence.fragileFiles?.size ?? 0,
      failureFingerprints: evidence.failureFingerprints?.size ?? 0,
    });
  });

  // ── Gate state query ───────────────────────────────────
  app.get('/operator/tool-gate/state', async (req) => {
    const query = (req.query ?? {}) as {
      sessionId?: string;
      tenantId?: string;
      projectId?: string;
    };
    const evidence = await loadPreActionEvidence(query);
    return {
      fragileFilesCount: evidence.fragileFiles?.size ?? 0,
      fragileFiles: [...(evidence.fragileFiles ?? [])].slice(0, 100),
      failureFingerprintsCount: evidence.failureFingerprints?.size ?? 0,
      alwaysBlockPatterns: ALWAYS_BLOCK_TOOL_PATTERNS.map(p => ({
        tool: p.tool,
        reasonCode: p.reasonCode,
      })),
    };
  });

  // ── Add/remove fragile files (operator management) ─────
  app.post('/operator/tool-gate/fragile-files', async (req, reply) => {
    const body = (req.body ?? {}) as {
      action: 'add' | 'remove';
      paths: string[];
      source?: string;
    };
    if (!body.paths?.length || (body.action !== 'add' && body.action !== 'remove')) {
      return reply.status(400).send({ error: 'action and paths array are required' });
    }
    for (const path of body.paths) {
      await appendSessionEvent({
        sessionId: _GLOBAL_PRE_ACTION_SESSION_ID,
        type: `tool.pre_action.fragile_file.${body.action === 'add' ? 'added' : 'removed'}`,
        source: body.source ?? 'operator',
        payload: { path },
      });
    }
    const evidence = await loadPreActionEvidence({});
    return reply.send({ fragileFiles: [...(evidence.fragileFiles ?? [])] });
  });
}
