import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getLogger } from '@los/infra/logger';
import { redactExternalSummaryText } from '../external-tool-summary.js';
import type { RuntimeHandle } from './types.js';

const log = getLogger('grok-adapter');
const GROK_DEFAULT_MODEL = 'grok-4.5';
const GROK_OUTPUT_LIMIT_BYTES = 65_536;

export interface GrokSpawnInput {
  prompt: string;
  workspaceRoot: string;
  sessionId?: string;
  timeoutMs?: number;
  grokPath?: string;
  outputLimitBytes?: number;
}

export interface GrokRuntimeOutput {
  text: string;
  capturedBytes: number;
  totalBytes: number;
  stderrBytes: number;
  truncated: boolean;
  errorCode?: 'grok_spawn_failed';
}

export interface GrokRuntimeHandle extends RuntimeHandle {
  output: Promise<GrokRuntimeOutput>;
}

export function getGrokRuntimeModel(): string {
  return GROK_DEFAULT_MODEL;
}

export function spawnGrok(input: GrokSpawnInput): GrokRuntimeHandle {
  const sessionId = input.sessionId ?? `grok-${randomUUID()}`;
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const outputLimitBytes = normalizeOutputLimit(input.outputLimitBytes);
  const grokPath = input.grokPath ?? 'grok';
  const proc: ChildProcess = spawn(grokPath, _buildGrokArgs(input.prompt), {
    cwd: input.workspaceRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });

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

  const settled = new Promise<{
    exit: { exitCode: number | null; signal: NodeJS.Signals | null };
    output: GrokRuntimeOutput;
  }>((resolve) => {
    proc.on('close', (exitCode, signal) => {
      const text = _redactGrokOutput(Buffer.concat(retained).toString('utf8'));
      log.info(
        `Grok runtime exited: session=${sessionId}, code=${exitCode}, signal=${signal ?? 'none'}, `
        + `stdout=${capturedBytes}/${totalBytes}B, stderr=${stderrBytes}B`,
      );
      resolve({
        exit: { exitCode, signal },
        output: {
          text,
          capturedBytes,
          totalBytes,
          stderrBytes,
          truncated: totalBytes > capturedBytes,
          ...(spawnFailed ? { errorCode: 'grok_spawn_failed' as const } : {}),
        },
      });
    });
  });

  return {
    sessionId,
    pid: proc.pid,
    kill: signal => proc.kill(signal),
    exited: settled.then(result => result.exit),
    output: settled.then(result => result.output),
  };
}

export function _buildGrokArgs(prompt: string): string[] {
  return [
    '--single', prompt,
    '--model', GROK_DEFAULT_MODEL,
    '--permission-mode', 'dontAsk',
  ];
}

export function _redactGrokOutput(value: string): string {
  const structured = value
    .replace(
      /("(?:access_token|refresh_token|api_key|key|cookie|authorization)"\s*:\s*")[^"]*(")/gi,
      '$1[redacted]$2',
    )
    .replace(
      /\b(GROK_AUTH|GROK_AUTH_PATH|XAI_API_KEY)\s*=\s*[^\s]+/gi,
      '$1=[redacted]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]');
  return redactExternalSummaryText([structured]).values[0] ?? '';
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return 120_000;
  if (!Number.isInteger(value) || value < 1_000 || value > 600_000) {
    throw new Error('timeoutMs must be an integer between 1000 and 600000');
  }
  return value;
}

function normalizeOutputLimit(value: number | undefined): number {
  if (value === undefined) return GROK_OUTPUT_LIMIT_BYTES;
  if (!Number.isInteger(value) || value < 1 || value > GROK_OUTPUT_LIMIT_BYTES) {
    throw new Error(`outputLimitBytes must be an integer between 1 and ${GROK_OUTPUT_LIMIT_BYTES}`);
  }
  return value;
}
