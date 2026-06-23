/**
 * @los/agent/message-router/handlers — Built-in intent handlers.
 *
 * Five handlers registered by priority:
 *   SteeringHandler (30)  — approve/deny/escalate → recordOperatorSteering
 *   StatusHandler   (30)  — query session state + observability
 *   TodoHandler     (40)  — list/show/create todos
 *   RuntimeHandler  (50)  — spawn Claude Code / Codex CLI
 *   ChatHandler     (100) — natural language → fallback to chat
 *
 * ChatHandler is a thin adapter — for HTTP sources it delegates to the
 * existing SSE streaming path; for bot sources it invokes runChat() directly.
 */

import { loadSession } from '@los/agent/session';
import { getSessionObservability } from '@los/agent/session-events';
import { recordOperatorSteering, recordOperatorFollowup } from '@los/agent/operator-control';
import { listTodos, loadTodo, createTodo } from '@los/agent/todos';
import {
  spawnClaudeCode,
  runClaudeCodeWithBridge,
  claudeCodeSupportsOtel,
  spawnCodex,
  codexSupportsOtel,
} from '@los/agent/runtime-adapter';
import type { Config } from '@los/infra/config';
import { listGovernanceJobs } from '../governance-jobs-crud.js';
import { runGovernanceSweep } from '../governance-sweeper.js';
import { ensureGovernanceJobStore, seedGovernanceJobs } from '../governance-jobs.js';
import type {
  HandlerDescriptor,
  HandlerContext,
  HandlerResult,
  ResolvedIntent,
} from './types.js';

// ── Dependencies (allows test injection) ────────────────────────

export interface HandlerDependencies {
  config: Config;
  gatewayServiceId?: string;
  /** Chat handler factory — for HTTP sources, delegates back to SSE stream */
  onChatIntent?: (ctx: HandlerContext) => Promise<HandlerResult>;
}

// ── Steering handler ────────────────────────────────────────────

function createSteeringHandler(): HandlerDescriptor {
  return {
    name: 'steering',
    priority: 30,
    match: (intent: ResolvedIntent) => intent.type === 'steering',
    handle: async (ctx) => {
      const i = ctx.intent;
      if (i.type !== 'steering') return { handled: false };
      try {
        await recordOperatorSteering({
          sessionId: i.sessionId,
          instruction: i.instruction,
          turnBoundary: i.turnBoundary ?? 'immediate',
          actor: ctx.inbound.channelId,
          reason: `MessageRouter steering via ${ctx.inbound.sourceKind}`,
        });
        const label = i.instruction === 'approve' ? '✅ Approved'
          : i.instruction === 'deny' ? '❌ Denied'
          : '↗ Escalated';
        const text = `${label} — session ${i.sessionId.slice(0, 8)}…`;
        await ctx.reply(text);
        return { handled: true, text, sessionId: i.sessionId };
      } catch (err) {
        await ctx.reply(`Steering failed: ${(err as Error).message}`);
        return { handled: true, error: (err as Error).message };
      }
    },
  };
}

// ── Status handler ──────────────────────────────────────────────

function createStatusHandler(): HandlerDescriptor {
  return {
    name: 'status',
    priority: 30,
    match: (intent: ResolvedIntent) => intent.type === 'status',
    handle: async (ctx) => {
      const i = ctx.intent;
      if (i.type !== 'status') return { handled: false };
      try {
        const session = await loadSession(i.sessionId);
        if (!session) {
          const text = `No session found for "${i.sessionId.slice(0, 8)}…"`;
          await ctx.reply(text);
          return { handled: true, text };
        }
        const obs = await getSessionObservability(i.sessionId);
        const statusText = [
          `📊 Session ${i.sessionId.slice(0, 8)}…`,
          `Events: ${obs.eventCount}`,
          `Turns: ${obs.turnCount}`,
          `Tokens: in=${obs.totalUsage.promptTokens} out=${obs.totalUsage.completionTokens} (cache: ${obs.totalUsage.cacheHitTokens})`,
          `First: ${obs.firstEventAt ?? 'unknown'} | Last: ${obs.lastEventAt ?? 'unknown'}`,
        ].join('\n');
        await ctx.reply(statusText);
        return { handled: true, text: statusText, sessionId: i.sessionId };
      } catch (err) {
        await ctx.reply(`Status query failed: ${(err as Error).message}`);
        return { handled: true, error: (err as Error).message };
      }
    },
  };
}

// ── Todo handler ────────────────────────────────────────────────

function createTodoHandler(): HandlerDescriptor {
  return {
    name: 'todo',
    priority: 40,
    match: (intent: ResolvedIntent) => intent.type === 'todo',
    handle: async (ctx) => {
      const i = ctx.intent;
      if (i.type !== 'todo') return { handled: false };
      try {
        if (i.action === 'list') {
          const todos = await listTodos({ status: 'ready', limit: 10 });
          if (todos.length === 0) {
            await ctx.reply('No open todos.');
            return { handled: true, text: 'No open todos.' };
          }
          const lines = todos.map(t =>
            `${t.status === 'in_progress' ? '🔄' : '📋'} ${t.id.slice(0, 8)}… — ${(t.title ?? 'untitled').slice(0, 80)}`
          );
          const text = `📋 Open todos (${todos.length}):\n${lines.join('\n')}`;
          await ctx.reply(text);
          return { handled: true, text };
        }
        if (i.action === 'show' && i.todoId) {
          const todo = await loadTodo(i.todoId);
          if (!todo) {
            const text = `Todo "${i.todoId.slice(0, 8)}…" not found.`;
            await ctx.reply(text);
            return { handled: true, text };
          }
          const text = [
            `📋 ${todo.title ?? 'Untitled'}`,
            `ID: ${todo.id.slice(0, 8)}…`,
            `Status: ${todo.status}`,
            `Priority: ${todo.priority ?? 'normal'}`,
            todo.description ? `\n${todo.description.slice(0, 200)}` : '',
          ].filter(Boolean).join('\n');
          await ctx.reply(text);
          return { handled: true, text };
        }
        if (i.action === 'create' && i.title) {
          const todo = await createTodo({
            title: i.title,
            priority: 'P2',
            source: `message-router:${ctx.inbound.sourceKind}`,
          });
          const text = `✅ Created todo: ${todo.id.slice(0, 8)}… — "${i.title}"`;
          await ctx.reply(text);
          return { handled: true, text, sessionId: todo.sessionId ?? undefined };
        }
        await ctx.reply('Usage: #task | #task <id> | #task new <title>');
        return { handled: true };
      } catch (err) {
        await ctx.reply(`Todo operation failed: ${(err as Error).message}`);
        return { handled: true, error: (err as Error).message };
      }
    },
  };
}

// ── Runtime handler ─────────────────────────────────────────────

function createRuntimeHandler(): HandlerDescriptor {
  return {
    name: 'runtime',
    priority: 50,
    match: (intent: ResolvedIntent) => intent.type === 'runtime',
    handle: async (ctx) => {
      const i = ctx.intent;
      if (i.type !== 'runtime') return { handled: false };
      try {
        if (i.kind === 'claude-code') {
          if (!claudeCodeSupportsOtel()) {
            await ctx.reply('Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code');
            return { handled: true, error: 'claude_code_not_available' };
          }
          await ctx.reply(`🔄 Starting Claude Code: "${i.prompt.slice(0, 100)}…"`);

          const { handle, bridgeStop } = await runClaudeCodeWithBridge({
            kind: 'claude-code' as const,
            sessionId: `msgrouter-cc-${Date.now()}`,
            workspaceRoot: process.cwd(),
            prompt: i.prompt,
            timeoutMs: 300_000,
          });
          const exit = await handle.exited;
          await bridgeStop();

          const text = exit.exitCode === 0
            ? `✅ Claude Code completed (exit 0)`
            : `⚠️ Claude Code exited with code ${exit.exitCode}${exit.signal ? ` (signal: ${exit.signal})` : ''}`;
          await ctx.reply(text);
          return { handled: true, text };
        }

        if (i.kind === 'codex') {
          if (!codexSupportsOtel()) {
            await ctx.reply('Codex CLI not found. Install and try again.');
            return { handled: true, error: 'codex_not_available' };
          }
          await ctx.reply(`🔄 Starting Codex: "${i.prompt.slice(0, 100)}…"`);

          const handle = spawnCodex({
            sessionId: `msgrouter-cx-${Date.now()}`,
            workspaceRoot: process.cwd(),
            prompt: i.prompt,
            otelEndpoint: 'http://127.0.0.1:4318',
            timeoutMs: 300_000,
          });
          const exit = await handle.exited;

          const text = exit.exitCode === 0
            ? `✅ Codex completed (exit 0)`
            : `⚠️ Codex exited with code ${exit.exitCode}${exit.signal ? ` (signal: ${exit.signal})` : ''}`;
          await ctx.reply(text);
          return { handled: true, text };
        }

        return { handled: true, error: `Unknown runtime kind: ${(i as any).kind}` };
      } catch (err) {
        await ctx.reply(`Runtime execution failed: ${(err as Error).message}`);
        return { handled: true, error: (err as Error).message };
      }
    },
  };
}

// ── Governance handler ─────────────────────────────────────────

const KNOWN_JOB_TYPES = [
  'consistency_audit', 'hotspot', 'architecture_drift',
  'memory_integrity', 'memory_retention', 'reflection',
  'branch_cleanup', 'related_project_scan', 'file_size',
] as const;

function createGovernanceHandler(): HandlerDescriptor {
  const CIRCUIT_ICON: Record<string, string> = {
    closed: '🟢', half_open: '🟡', open: '🔴',
  };
  const CADENCE_ICON: Record<string, string> = {
    daily: '📅', hourly: '⏱️', weekly: '📆', manual: '🔧',
  };

  return {
    name: 'governance',
    priority: 45,
    match: (intent: ResolvedIntent) => intent.type === 'governance',
    handle: async (ctx) => {
      const i = ctx.intent;
      if (i.type !== 'governance') return { handled: false };
      try {
        await ensureGovernanceJobStore();
        await seedGovernanceJobs();

        if (i.action === 'list') {
          const jobs = await listGovernanceJobs({ limit: 20 });
          if (jobs.length === 0) {
            await ctx.reply('No governance jobs configured.');
            return { handled: true, text: 'No governance jobs.' };
          }
          const lines = jobs.map(j => {
            const ci = CIRCUIT_ICON[j.circuitState] ?? '⚪';
            const mi = CADENCE_ICON[j.cadence] ?? '';
            const af = j.autoFix?.autoFixEnabled ? '⚙️' : '👀';
            const noOp = j.consecutiveNoOps > 0 ? ` noop×${j.consecutiveNoOps}` : '';
            const fail = j.consecutiveFailures > 0 ? ` fail×${j.consecutiveFailures}` : '';
            const last = j.lastRunAt
              ? new Date(j.lastRunAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
              : 'never';
            return `${ci}${mi}${af} ${j.jobType} | ${j.circuitState}${noOp}${fail} | last: ${last}`;
          });
          const text = `📊 Governance (${jobs.length} jobs):\n${lines.join('\n')}`;
          await ctx.reply(text);
          return { handled: true, text };
        }

        if (i.action === 'show' && i.jobType) {
          const jobs = await listGovernanceJobs({ jobType: i.jobType as any, limit: 5 });
          if (jobs.length === 0) {
            const knownList = (KNOWN_JOB_TYPES as readonly string[]).join(', ');
            await ctx.reply(`Unknown job type "${i.jobType}". Known: ${knownList}`);
            return { handled: true, text: `Unknown job: ${i.jobType}` };
          }
          const j = jobs[0];
          const ci = CIRCUIT_ICON[j.circuitState] ?? '⚪';
          const autoFix = j.autoFix;
          const lastRun = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString('zh-CN') : 'never';
          const resultKeys = j.resultSummary ? Object.keys(j.resultSummary).join(', ') : 'none';
          const text = [
            `${ci} ${j.jobType} (${j.cadence})`,
            `Circuit: ${j.circuitState} | no-op×${j.consecutiveNoOps} | fail×${j.consecutiveFailures}`,
            autoFix?.autoFixEnabled
              ? `AutoFix: ${autoFix.stopCondition ?? 'enabled'} | max attempts: ${autoFix.maxAutoFixAttempts ?? 3}`
              : 'AutoFix: disabled',
            `Last run: ${lastRun}`,
            `Results: ${resultKeys}`,
            j.dedupeKey ? `Dedupe: ${j.dedupeKey.slice(0, 12)}…` : '',
          ].filter(Boolean).join('\n');
          await ctx.reply(text);
          return { handled: true, text };
        }

        if (i.action === 'sweep') {
          await ctx.reply('🔄 Triggering governance sweep...');
          const result = await runGovernanceSweep({ dryRun: false });
          const text = [
            result.dryRun ? '🔍 DRY RUN' : '✅ Sweep complete',
            `Jobs run: ${result.jobsRun} | Skipped: ${result.jobsSkipped}`,
            `Findings: ${result.findingsCreated} | Errors: ${result.errors.length}`,
            ...result.results.slice(0, 5).map(r =>
              `  ${r.jobType}: ${r.durationMs}ms${(r.summary as Record<string, unknown>)?._gaLoop ? ' [GA]' : ''}`
            ),
            result.results.length > 5 ? `  … and ${result.results.length - 5} more` : '',
          ].filter(Boolean).join('\n');
          await ctx.reply(text);
          return { handled: true, text };
        }

        await ctx.reply('Usage: #jobs | #governance [jobType] | #sweep');
        return { handled: true };
      } catch (err) {
        await ctx.reply(`Governance operation failed: ${(err as Error).message}`);
        return { handled: true, error: (err as Error).message };
      }
    },
  };
}

// ── Chat handler (fallback — delegates to onChatIntent) ─────────

function createChatHandler(deps: HandlerDependencies): HandlerDescriptor {
  return {
    name: 'chat',
    priority: 100,
    match: (intent: ResolvedIntent) => intent.type === 'chat' || intent.type === 'unknown',
    handle: async (ctx) => {
      if (deps.onChatIntent) {
        return deps.onChatIntent(ctx);
      }
      // Bot processes without a custom chat handler: tell them to use #claude or #codex
      const text = 'Bot chat not configured. Use #claude <prompt> or #codex <prompt> to run an external agent.';
      await ctx.reply(text);
      return { handled: true, text };
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────

export function createBuiltinHandlers(deps: HandlerDependencies): HandlerDescriptor[] {
  return [
    createSteeringHandler(),
    createStatusHandler(),
    createTodoHandler(),
    createGovernanceHandler(),
    createRuntimeHandler(),
    createChatHandler(deps),
  ];
}
