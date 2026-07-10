/**
 * @los/gateway runtime-adapter routes — API for running external agent CLIs.
 *
 * POST /runtimes/:kind/run  — spawn an external agent and stream events back
 * POST /runtimes/bridge/start — start the OTel bridge (if not auto-started)
 * GET  /runtimes/bridge/status — check OTel bridge status
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  runClaudeCodeWithBridge,
  startOtelBridge,
  isOtelBridgeRunning,
  claudeCodeSupportsOtel,
  type RuntimeKind,
} from '@los/agent/runtime-adapter';
import { getConfig } from '@los/infra/config';
import { getLogger } from '@los/infra/logger';
import type { MessageRouter } from '@los/agent/message-router';
import { requireOperator } from '../../request-context.js';

const log = getLogger('runtime-adapter-routes');

interface RunRuntimeBody {
  prompt: string;
  workspaceRoot?: string;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export function registerRuntimeAdapterRoutes(app: FastifyInstance, messageRouter?: MessageRouter): void {
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
      message: `Unknown runtime kind: ${kind}. Supported: claude-code, codex`,
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
