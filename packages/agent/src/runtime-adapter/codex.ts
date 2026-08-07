/**
 * @los/agent/runtime-adapter/codex — Codex runtime adapter.
 *
 * Codex supports OTel natively (like Claude Code), so this is a thin
 * wrapper that sets OTel env vars and spawns the codex CLI.
 *
 * Fallback: if Codex doesn't support OTel, a stdout JSONL parser could
 * be added here (similar to the Claude Code debug parser pattern).
 */

import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getLogger } from '@los/infra/logger';
import type { RuntimeHandle } from './types.js';

const log = getLogger('codex-adapter');

export interface CodexSpawnInput {
  prompt: string;
  workspaceRoot: string;
  sessionId?: string;
  otelEndpoint: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  requestId?: string;
  traceId?: string;
  timeoutMs?: number;
  codexPath?: string;
  extraArgs?: string[];
  /** Max stdout bytes retained for callers (default 128k, clamp [4k, 512k]). */
  outputLimitBytes?: number;
  env?: Record<string, string>;
}

export function codexSupportsOtel(codexPath = 'codex'): boolean {
  try {
    const out = execSync(`${codexPath} --version`, { encoding: 'utf-8', timeout: 5_000 }).trim();
    // OTel support: >= 1.0, or 0.146+ (OTel env support landed in 0.146,
    // verified 2026-08 via los runtime-adapter).
    const versionMatch = out.match(/(\d+)\.(\d+)/);
    if (!versionMatch) return false;
    const major = Number(versionMatch[1]);
    const minor = Number(versionMatch[2]);
    return major >= 1 || (major === 0 && minor >= 146);
  } catch {
    return false;
  }
}

export interface CodexRuntimeOutput {
  exitCode: number | null;
  output: string;
  outputBytes: number;
  truncated: boolean;
  stderrBytes: number;
  spawnFailed: boolean;
}

export interface CodexRuntimeHandle extends RuntimeHandle {
  output: Promise<CodexRuntimeOutput>;
}

export function spawnCodex(input: CodexSpawnInput): CodexRuntimeHandle {
  const {
    sessionId = `codex-${randomUUID()}`,
    workspaceRoot,
    prompt,
    otelEndpoint,
    tenantId,
    projectId,
    userId,
    requestId,
    traceId = randomUUID(),
    timeoutMs = 600_000,
    codexPath = 'codex',
    extraArgs = [],
    env: extraEnv = {},
  } = input;

  const otelEnv: Record<string, string> = {
    CODEX_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',   // JSON over HTTP
    OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint,
    OTEL_RESOURCE_ATTRIBUTES: [
      `session.id=${sessionId}`,
      tenantId ? `los.tenant_id=${tenantId}` : '',
      projectId ? `los.project_id=${projectId}` : '',
      userId ? `los.user_id=${userId}` : '',
      requestId ? `los.request_id=${requestId}` : '',
      `los.trace_id=${traceId}`,
      'los.source=codex',
    ].filter(Boolean).join(','),
    TRACEPARENT: `00-${traceId}-${randomUUID().replace(/-/g, '').slice(0, 16)}-01`,
  };

  if (!codexSupportsOtel(codexPath)) {
    log.warn('Codex OTel support uncertain — telemetry may not be emitted');
  }

  const proc: ChildProcess = spawn(codexPath, ['exec', prompt, ...extraArgs], {
    cwd: workspaceRoot,
    env: { ...process.env, ...otelEnv, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });

  // Collect stdout/stderr (bounded) so callers can surface the result text.
  const outputLimitBytes = Math.max(4_096, Math.min(512_000, input.outputLimitBytes ?? 128_000));
  const retained: Buffer[] = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  let stderrBytes = 0;
  let spawnFailed = false;
  proc.stdout?.on('data', (chunk: Buffer) => {
    totalBytes += chunk.byteLength;
    const remaining = outputLimitBytes - capturedBytes;
    if (remaining <= 0) return;
    const bounded = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    retained.push(bounded);
    capturedBytes += bounded.byteLength;
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
  });
  proc.on('error', () => {
    spawnFailed = true;
  });

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on('close', (exitCode, signal) => {
      log.info(`Codex exited: code=${exitCode}, signal=${signal ?? 'none'}`);
      resolve({ exitCode, signal });
    });
    proc.on('error', (err) => {
      log.error(`Codex process error: ${err.message}`);
      resolve({ exitCode: null, signal: null });
    });
  });

  return {
    sessionId,
    pid: proc.pid,
    kill: (signal) => proc.kill(signal),
    exited,
    output: exited.then(({ exitCode }) => ({
      exitCode,
      output: Buffer.concat(retained).toString('utf8'),
      outputBytes: capturedBytes,
      truncated: capturedBytes < totalBytes,
      stderrBytes,
      spawnFailed,
    })),
  };
}
