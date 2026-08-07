/**
 * @los/gateway runtime-adapter routes — operator API for external agent CLIs.
 *
 * GET  /runtimes/capabilities — discover live and planned runtime profiles
 * POST /runtimes/:kind/run   — stream one bounded external-runtime invocation
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  claudeCodeAvailable,
  getGrokRuntimeModel,
  isOtelBridgeRunning,
  runClaudeCodeWithBridge,
  spawnCodex,
  spawnGrok,
  startOtelBridge,
  codexAvailable,
  type ClaudeCodeRuntimeHandle,
} from '@los/agent/runtime-adapter';
import {
  getExternalRuntimeCapabilities,
  runExternalRuntime,
  type ExternalRuntimeEvent,
  type RuntimeTaskKind,
} from '@los/agent/runtime-task';
import { scanGrokAccount, type GrokAccountCandidate } from '@los/infra/discovery';
import { getLogger } from '@los/infra/logger';
import {
  loadProviderAccount,
  setProviderAccountState,
  type ProviderAccountRecord,
  type SetProviderAccountStateInput,
} from '@los/infra/provider-accounts';
import type { MessageRouter } from '@los/agent/message-router';
import { requireOperator } from '../../request-context.js';

const log = getLogger('runtime-adapter-routes');

interface RunRuntimeBody {
  prompt: string;
  workspaceRoot?: string | null;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface GrokRuntimeRouteDependencies {
  scanGrokAccount: () => GrokAccountCandidate;
  loadProviderAccount: (id: string) => Promise<ProviderAccountRecord | null>;
  setProviderAccountState: (input: SetProviderAccountStateInput) => Promise<ProviderAccountRecord>;
  spawnGrok: typeof spawnGrok;
  persistRuntimeEvent?: (event: ExternalRuntimeEvent) => Promise<void>;
}

export interface CodexRuntimeDependencies {
  codexAvailable?: () => boolean;
  /** Compatibility injection for the pre-#220 tests; availability no longer implies configured OTel export. */
  codexSupportsOtel?: () => boolean;
  spawnCodex?: typeof spawnCodex;
  isOtelBridgeRunning?: () => boolean;
  startOtelBridge?: typeof startOtelBridge;
}

export interface ClaudeRuntimeDependencies {
  claudeCodeAvailable?: () => boolean;
  runClaudeCodeWithBridge?: (input: Parameters<typeof runClaudeCodeWithBridge>[0]) => Promise<{
    handle: ClaudeCodeRuntimeHandle;
    bridgeStop: () => Promise<void>;
  }>;
}

export interface RuntimeAdapterRouteDependencies extends GrokRuntimeRouteDependencies {
  codex?: CodexRuntimeDependencies;
  claude?: ClaudeRuntimeDependencies;
}

const DEFAULT_DEPENDENCIES: RuntimeAdapterRouteDependencies = {
  scanGrokAccount,
  loadProviderAccount,
  setProviderAccountState,
  spawnGrok,
};

async function handleRunRuntime(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: RuntimeAdapterRouteDependencies,
): Promise<unknown> {
  if (!(await requireOperator(req, reply))) return;
  const { kind } = req.params as { kind: string };
  const body = (req.body ?? {}) as RunRuntimeBody;
  if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return reply.status(400).send({ error: 'prompt is required' });
  }
  if (kind === 'gemini') {
    return reply.status(501).send({ error: 'not_implemented', message: 'Gemini CLI adapter is not implemented.' });
  }
  if (!isRuntimeTaskKind(kind)) {
    return reply.status(400).send({
      error: 'unknown_runtime',
      message: `Unknown runtime kind: ${kind}. Supported: claude-code, codex, grok`,
    });
  }
  if (body.timeoutMs !== undefined && !isRuntimeTimeout(body.timeoutMs)) {
    return reply.status(400).send({
      error: 'invalid_timeout',
      message: 'timeoutMs must be an integer between 1000 and 600000',
    });
  }

  const workspace = validateWorkspace(body.workspaceRoot ?? process.cwd());
  if (!workspace.ok) {
    return reply.status(400).send({ error: 'invalid_workspace', message: workspace.message });
  }

  let grokAccount: ProviderAccountRecord | undefined;
  if (kind === 'grok') {
    if (Object.hasOwn(body, 'env') || Object.hasOwn(body, 'extraArgs')) {
      return reply.status(400).send({
        error: 'grok_runtime_options_forbidden',
        message: 'Grok runtime does not accept browser-supplied env or extraArgs',
      });
    }
    const account = await deps.loadProviderAccount('xai-grok-default');
    if (!isActiveGrokAccount(account)) {
      return reply.status(409).send({
        error: 'grok_account_not_active',
        message: 'Adopt the discovered Grok CLI login before running this runtime',
      });
    }
    const candidate = deps.scanGrokAccount();
    if (!candidate.available) {
      return reply.status(503).send({ error: 'grok_login_unavailable', reason: candidate.reason });
    }
    grokAccount = account;
  }
  if (kind === 'codex' && !resolveCodexAvailability(deps)) {
    return reply.status(400).send({ error: 'codex_not_available', message: 'Codex CLI not found. Install and try again.' });
  }
  if (kind === 'claude-code' && !(deps.claude?.claudeCodeAvailable ?? claudeCodeAvailable)()) {
    return reply.status(400).send({
      error: 'claude_code_not_available',
      message: 'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code',
    });
  }

  const sessionId = body.sessionId ?? `ext-${kind}-${randomUUID()}`;
  const traceId = randomUUID();
  const send = setupSSE(reply);
  const controller = new AbortController();
  const cancelOnDisconnect = () => controller.abort();
  reply.raw.once('close', cancelOnDisconnect);

  try {
    const result = await runExternalRuntime({
      kind,
      prompt: body.prompt,
      workspaceRoot: workspace.path,
      sessionId,
      traceId,
      tenantId: body.tenantId,
      projectId: body.projectId,
      timeoutMs: body.timeoutMs,
      extraArgs: body.extraArgs,
      env: body.env,
      signal: controller.signal,
      providerAccountId: grokAccount?.id,
      model: kind === 'grok' ? getGrokRuntimeModel() : undefined,
      onEvent: event => send(event.type, event),
    }, {
      spawnGrok: deps.spawnGrok,
      spawnCodex: deps.codex?.spawnCodex ?? spawnCodex,
      runClaudeCodeWithBridge: deps.claude?.runClaudeCodeWithBridge ?? runClaudeCodeWithBridge,
      isOtelBridgeRunning: deps.codex?.isOtelBridgeRunning ?? isOtelBridgeRunning,
      startOtelBridge: deps.codex?.startOtelBridge ?? startOtelBridge,
      ...(deps.persistRuntimeEvent ? { persistEvent: deps.persistRuntimeEvent } : {}),
    });
    if (kind === 'grok' && result.exitCode === 0 && !result.spawnFailed && !result.error && grokAccount) {
      await recordGrokVerification(deps, grokAccount);
    }
  } finally {
    reply.raw.removeListener('close', cancelOnDisconnect);
    reply.raw.end();
  }
}

async function handleCapabilities(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: RuntimeAdapterRouteDependencies,
): Promise<unknown> {
  if (!(await requireOperator(req, reply))) return;
  const [account, candidate] = await Promise.all([
    deps.loadProviderAccount('xai-grok-default'),
    Promise.resolve(deps.scanGrokAccount()),
  ]);
  const grokAvailable = isActiveGrokAccount(account) && candidate.available;
  return {
    generatedAt: new Date().toISOString(),
    runtimes: getExternalRuntimeCapabilities({
      codex: {
        available: resolveCodexAvailability(deps),
        reason: 'codex_cli_not_available',
      },
      grok: {
        available: grokAvailable,
        reason: !isActiveGrokAccount(account) ? 'grok_account_not_active' : candidate.reason ?? 'grok_login_unavailable',
      },
      claudeCode: {
        available: (deps.claude?.claudeCodeAvailable ?? claudeCodeAvailable)(),
        reason: 'claude_code_cli_not_available',
      },
    }),
  };
}

async function handleBridgeStart(req: FastifyRequest, reply: FastifyReply) {
  if (!(await requireOperator(req, reply))) return;
  if (isOtelBridgeRunning()) return { status: 'already_running' };
  try {
    const bridge = await startOtelBridge({ source: 'gateway' });
    log.info(`OTel bridge started on port ${bridge.port} via API`);
    return { status: 'started', port: bridge.port };
  } catch (error) {
    return reply.status(500).send({ error: error instanceof Error ? error.message : String(error) });
  }
}

function handleBridgeStatus() {
  return { running: isOtelBridgeRunning() };
}

export function registerRuntimeAdapterRoutes(
  app: FastifyInstance,
  _messageRouter?: MessageRouter,
  deps: RuntimeAdapterRouteDependencies = DEFAULT_DEPENDENCIES,
): void {
  app.get('/runtimes/capabilities', (req, reply) => handleCapabilities(req, reply, deps));
  app.post('/runtimes/:kind/run', (req, reply) => handleRunRuntime(req, reply, deps));
  app.post('/runtimes/bridge/start', (req, reply) => handleBridgeStart(req, reply));
  app.get('/runtimes/bridge/status', () => handleBridgeStatus());
}

function setupSSE(reply: FastifyReply): (event: string, data: unknown) => void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return (event, data) => {
    if (reply.raw.destroyed || reply.raw.writableEnded) return;
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

async function recordGrokVerification(
  deps: RuntimeAdapterRouteDependencies,
  account: ProviderAccountRecord,
): Promise<void> {
  try {
    await deps.setProviderAccountState({
      id: account.id,
      expectedCredentialGeneration: account.credentialGeneration,
      state: 'active',
      verifiedAt: new Date().toISOString(),
    });
  } catch {
    log.warn(`Could not record Grok verification for account=${account.id}`);
  }
}

function resolveCodexAvailability(deps: RuntimeAdapterRouteDependencies): boolean {
  return (deps.codex?.codexAvailable ?? deps.codex?.codexSupportsOtel ?? codexAvailable)();
}

function isRuntimeTaskKind(kind: string): kind is RuntimeTaskKind {
  return kind === 'claude-code' || kind === 'codex' || kind === 'grok';
}

function isActiveGrokAccount(account: ProviderAccountRecord | null): account is ProviderAccountRecord {
  return account?.id === 'xai-grok-default'
    && account.provider === 'xai'
    && account.authMode === 'external_ref'
    && account.secretRef === 'external:grok/default'
    && account.secretScope === 'external_backend'
    && account.state === 'active';
}

function validateWorkspace(value: string): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, message: 'workspaceRoot must be a non-empty directory path' };
  }
  const path = resolve(value);
  try {
    if (!statSync(path).isDirectory()) return { ok: false, message: 'workspaceRoot must be a directory' };
    return { ok: true, path };
  } catch {
    return { ok: false, message: 'workspaceRoot does not exist or is not readable' };
  }
}

function isRuntimeTimeout(value: number): boolean {
  return Number.isInteger(value) && value >= 1_000 && value <= 600_000;
}
