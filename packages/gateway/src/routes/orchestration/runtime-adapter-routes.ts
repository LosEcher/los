/**
 * @los/gateway runtime-adapter routes — API for running external agent CLIs.
 *
 * POST /runtimes/:kind/run  — spawn an external agent and stream events back
 * POST /runtimes/bridge/start — start the OTel bridge (if not auto-started)
 * GET  /runtimes/bridge/status — check OTel bridge status
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getGrokRuntimeModel,
  spawnGrok,
  runClaudeCodeWithBridge,
  startOtelBridge,
  isOtelBridgeRunning,
  claudeCodeSupportsOtel,
  type RuntimeKind,
  type GrokRuntimeHandle,
} from '@los/agent/runtime-adapter';
import { getConfig } from '@los/infra/config';
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
  spawnGrok: (input: {
    prompt: string;
    workspaceRoot: string;
    sessionId: string;
    timeoutMs?: number;
  }) => GrokRuntimeHandle;
}

const DEFAULT_GROK_DEPENDENCIES: GrokRuntimeRouteDependencies = {
  scanGrokAccount,
  loadProviderAccount,
  setProviderAccountState,
  spawnGrok,
};

export function registerRuntimeAdapterRoutes(
  app: FastifyInstance,
  messageRouter?: MessageRouter,
  grokDeps: GrokRuntimeRouteDependencies = DEFAULT_GROK_DEPENDENCIES,
): void {
  const config = getConfig();

  // ── Run external agent ───────────────────────────────────
  app.post('/runtimes/:kind/run', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { kind } = req.params as { kind: string };
    const body = (req.body ?? {}) as RunRuntimeBody;

    if (!body.prompt || typeof body.prompt !== 'string') {
      return reply.status(400).send({ error: 'prompt is required' });
    }

    // ── Route handler shared setup (SSE) ──────────────────
    // Setup SSE reply and send helper at route scope so both branches can use it.
    const setupSSE = () => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      return (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };
    };

    const workspaceRoot = body.workspaceRoot ?? process.cwd();
    const sessionId = body.sessionId ?? `ext-${kind}-${randomUUID()}`;
    const traceId = randomUUID();

    if (kind === 'grok') {
      if (Object.hasOwn(body, 'env') || Object.hasOwn(body, 'extraArgs')) {
        return reply.status(400).send({
          error: 'grok_runtime_options_forbidden',
          message: 'Grok runtime does not accept browser-supplied env or extraArgs',
        });
      }
      const validatedWorkspace = validateGrokWorkspace(workspaceRoot);
      if (!validatedWorkspace.ok) {
        return reply.status(400).send({ error: 'invalid_workspace', message: validatedWorkspace.message });
      }
      if (body.timeoutMs !== undefined && !isGrokTimeout(body.timeoutMs)) {
        return reply.status(400).send({
          error: 'invalid_timeout',
          message: 'timeoutMs must be an integer between 1000 and 600000',
        });
      }

      const account = await grokDeps.loadProviderAccount('xai-grok-default');
      if (!isActiveGrokAccount(account)) {
        return reply.status(409).send({
          error: 'grok_account_not_active',
          message: 'Adopt the discovered Grok CLI login before running this runtime',
        });
      }
      const candidate = grokDeps.scanGrokAccount();
      if (!candidate.available) {
        return reply.status(503).send({
          error: 'grok_login_unavailable',
          reason: candidate.reason,
        });
      }

      const send = setupSSE();
      send('runtime.started', {
        kind,
        sessionId,
        traceId,
        workspaceRoot: validatedWorkspace.path,
        providerAccountId: account.id,
        model: getGrokRuntimeModel(),
      });

      try {
        const handle = grokDeps.spawnGrok({
          sessionId,
          workspaceRoot: validatedWorkspace.path,
          prompt: body.prompt,
          timeoutMs: body.timeoutMs,
        });
        send('runtime.process', {
          sessionId,
          pid: handle.pid,
          providerAccountId: account.id,
        });
        const [exit, output] = await Promise.all([handle.exited, handle.output]);
        if (output.errorCode) {
          send('runtime.error', {
            sessionId,
            traceId,
            providerAccountId: account.id,
            error: output.errorCode,
          });
        } else {
          if (exit.exitCode === 0) {
            try {
              await grokDeps.setProviderAccountState({
                id: account.id,
                expectedCredentialGeneration: account.credentialGeneration,
                state: 'active',
                verifiedAt: new Date().toISOString(),
              });
            } catch {
              log.warn(`Could not record Grok verification for account=${account.id}`);
            }
          }
          send('runtime.output', {
            sessionId,
            providerAccountId: account.id,
            text: output.text,
            capturedBytes: output.capturedBytes,
            totalBytes: output.totalBytes,
            truncated: output.truncated,
          });
          send('runtime.completed', {
            sessionId,
            traceId,
            providerAccountId: account.id,
            exitCode: exit.exitCode,
            signal: exit.signal,
            status: exit.exitCode === 0 ? 'success' : 'failed',
          });
        }
      } catch {
        send('runtime.error', {
          sessionId,
          traceId,
          providerAccountId: account.id,
          error: 'grok_runtime_failed',
        });
      } finally {
        reply.raw.end();
      }
      return;
    }

    if (kind === 'claude-code') {
      // Check Claude Code availability
      if (!claudeCodeSupportsOtel()) {
        return reply.status(400).send({
          error: 'claude_code_not_available',
          message: 'Claude Code CLI not found or version < 1.0. Install with: npm install -g @anthropic-ai/claude-code',
        });
      }

      const send = setupSSE();

      send('runtime.started', {
        kind,
        sessionId,
        traceId,
        workspaceRoot,
        prompt: body.prompt.slice(0, 200),
      });

      try {
        const { handle, bridgeStop } = await runClaudeCodeWithBridge({
          kind: 'claude-code' as const,
          sessionId,
          workspaceRoot,
          prompt: body.prompt,
          tenantId: body.tenantId,
          projectId: body.projectId,
          traceId,
          timeoutMs: body.timeoutMs,
          extraArgs: body.extraArgs ?? [],
          env: body.env,
        });

        send('runtime.process', {
          sessionId,
          pid: handle.pid,
        });

        const exit = await handle.exited;
        await bridgeStop();

        send('runtime.completed', {
          sessionId,
          traceId,
          exitCode: exit.exitCode,
          signal: exit.signal,
          status: exit.exitCode === 0 ? 'success' : 'failed',
        });
      } catch (err: any) {
        send('runtime.error', {
          sessionId,
          traceId,
          error: err?.message ?? String(err),
        });
      } finally {
        reply.raw.end();
      }
      return;
    }

    if (kind === 'codex') {
      const send = setupSSE();
      try {
        const { spawnCodex, codexSupportsOtel, startOtelBridge, isOtelBridgeRunning } = await import('@los/agent/runtime-adapter');

        if (!codexSupportsOtel()) {
          return reply.status(400).send({
            error: 'codex_not_available',
            message: 'Codex CLI not found. Install and try again.',
          });
        }

        let otelEndpoint: string;
        let bridgeStop = async () => {};
        if (isOtelBridgeRunning()) {
          otelEndpoint = 'http://127.0.0.1:4318';
        } else {
          const bridge = await startOtelBridge({ source: 'codex' });
          otelEndpoint = `http://127.0.0.1:${bridge.port}`;
          bridgeStop = bridge.stop;
        }

        const handle = spawnCodex({
          sessionId,
          workspaceRoot,
          prompt: body.prompt,
          otelEndpoint,
          tenantId: body.tenantId,
          projectId: body.projectId,
          traceId,
          timeoutMs: body.timeoutMs,
          extraArgs: body.extraArgs ?? [],
          env: body.env,
        });

        send('runtime.process', { sessionId, pid: handle.pid });

        const exit = await handle.exited;
        await bridgeStop();

        send('runtime.completed', {
          sessionId, traceId,
          exitCode: exit.exitCode,
          signal: exit.signal,
          status: exit.exitCode === 0 ? 'success' : 'failed',
        });
      } catch (err: any) {
        send('runtime.error', { sessionId, traceId, error: err?.message ?? String(err) });
      } finally {
        reply.raw.end();
      }
      return;
    }

    if (kind === 'gemini') {
      return reply.status(501).send({
        error: 'not_implemented',
        message: 'Gemini CLI adapter: reuses OTel bridge when Gemini CLI supports OTLP export. Fallback stdout parser not yet implemented.',
      });
    }

    return reply.status(400).send({
      error: 'unknown_runtime',
      message: `Unknown runtime kind: ${kind}. Supported: claude-code, codex, grok`,
    });
  });

  // ── OTel bridge management ───────────────────────────────
  app.post('/runtimes/bridge/start', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    if (isOtelBridgeRunning()) {
      return { status: 'already_running' };
    }
    try {
      const bridge = await startOtelBridge({ source: 'gateway' });
      log.info(`OTel bridge started on port ${bridge.port} via API`);
      return { status: 'started', port: bridge.port };
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? String(err) });
    }
  });

  app.get('/runtimes/bridge/status', async () => {
    return {
      running: isOtelBridgeRunning(),
    };
  });
}

function isActiveGrokAccount(account: ProviderAccountRecord | null): account is ProviderAccountRecord {
  return account?.id === 'xai-grok-default'
    && account.provider === 'xai'
    && account.authMode === 'external_ref'
    && account.secretRef === 'external:grok/default'
    && account.secretScope === 'external_backend'
    && account.state === 'active';
}

function validateGrokWorkspace(value: string): { ok: true; path: string } | { ok: false; message: string } {
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

function isGrokTimeout(value: number): boolean {
  return Number.isInteger(value) && value >= 1_000 && value <= 600_000;
}
