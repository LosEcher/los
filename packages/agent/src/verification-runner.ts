import { spawn } from 'node:child_process';
import { appendSessionEvent } from './session-events.js';
import { loadRunSpec, type RunSpecStatus } from './run-specs.js';
import { transitionExecutionState } from './execution-store.js';
import {
  listVerificationRecordsForRunSpec,
  loadVerificationRecord,
  updateVerificationRecord,
  type VerificationRecord,
} from './verification-records.js';

export interface VerificationCompletionDecision {
  status: Extract<RunSpecStatus, 'succeeded' | 'blocked'>;
  blockedVerificationRecordIds: string[];
  failedVerificationRecordIds: string[];
  pendingVerificationRecordIds: string[];
}

export interface VerificationCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputSummary: string;
  error?: string;
}

export interface RunVerificationRecordOptions {
  cwd?: string;
  timeoutMs?: number;
  outputLimit?: number;
  env?: Record<string, string | undefined>;
  updateRunSpecStatus?: boolean;
}

export interface RunVerificationRecordResult {
  record: VerificationRecord;
  commandResult: VerificationCommandResult;
  decision?: VerificationCompletionDecision;
}

export interface RunVerificationRecordsForRunSpecOptions extends RunVerificationRecordOptions {
  includeFailed?: boolean;
}

export interface RunVerificationRecordsForRunSpecResult {
  runSpecId: string;
  ranRecordIds: string[];
  records: VerificationRecord[];
  decision: VerificationCompletionDecision;
}

export function resolveVerificationCompletionDecision(
  verificationRecords: readonly Pick<VerificationRecord, 'id' | 'required' | 'status'>[],
): VerificationCompletionDecision {
  const blockedVerificationRecordIds = verificationRecords
    .filter(record => record.required && record.status !== 'succeeded' && record.status !== 'skipped')
    .map(record => record.id);
  const failedVerificationRecordIds = verificationRecords
    .filter(record => record.required && record.status === 'failed')
    .map(record => record.id);
  const pendingVerificationRecordIds = verificationRecords
    .filter(record => record.required && record.status !== 'succeeded' && record.status !== 'skipped' && record.status !== 'failed')
    .map(record => record.id);
  return {
    status: blockedVerificationRecordIds.length > 0 ? 'blocked' : 'succeeded',
    blockedVerificationRecordIds,
    failedVerificationRecordIds,
    pendingVerificationRecordIds,
  };
}

export async function runVerificationRecord(
  recordId: string,
  options: RunVerificationRecordOptions = {},
): Promise<RunVerificationRecordResult> {
  const initial = await loadVerificationRecord(recordId);
  if (!initial) throw new Error(`Verification record not found: ${recordId}`);

  const cwd = await resolveVerificationCwd(initial, options.cwd);
  const command = initial.command ?? initial.checkName;
  await updateVerificationRecord(initial.id, {
    status: 'running',
    error: null,
    outputSummary: `running: ${command}`,
  });
  await appendVerificationEvent(initial, 'verification.running', {
    command,
    cwd,
  });

  const commandResult = await runVerificationCommand(command, {
    cwd,
    timeoutMs: options.timeoutMs,
    outputLimit: options.outputLimit,
    env: options.env,
  });
  const status = commandResult.exitCode === 0 ? 'succeeded' : 'failed';
  const record = await updateVerificationRecord(initial.id, {
    status,
    outputSummary: commandResult.outputSummary,
    error: commandResult.error ?? null,
  });
  if (!record) throw new Error(`Verification record disappeared while running: ${recordId}`);

  await appendVerificationEvent(record, status === 'succeeded' ? 'verification.succeeded' : 'verification.failed', {
    command,
    cwd,
    exitCode: commandResult.exitCode,
    signal: commandResult.signal,
    durationMs: commandResult.durationMs,
    error: commandResult.error ?? null,
  });

  const decision = record.runSpecId && options.updateRunSpecStatus !== false
    ? await applyVerificationDecisionForRunSpec(record.runSpecId)
    : undefined;
  return { record, commandResult, decision };
}

export async function runVerificationRecordsForRunSpec(
  runSpecId: string,
  options: RunVerificationRecordsForRunSpecOptions = {},
): Promise<RunVerificationRecordsForRunSpecResult> {
  const initialRecords = await listVerificationRecordsForRunSpec(runSpecId);
  const runnable = initialRecords.filter(record => {
    if (!record.required) return false;
    if (record.status === 'required') return true;
    return options.includeFailed !== false && record.status === 'failed';
  });

  await transitionExecutionState({
    entityType: 'run_spec',
    entityId: runSpecId,
    to: 'running',
    reason: 'verification_started',
    sessionId: initialRecords[0]?.sessionId,
  }).catch(() => undefined);
  const ranRecordIds: string[] = [];
  for (const record of runnable) {
    await runVerificationRecord(record.id, {
      ...options,
      updateRunSpecStatus: false,
    });
    ranRecordIds.push(record.id);
  }

  const records = await listVerificationRecordsForRunSpec(runSpecId);
  const decision = await applyVerificationDecisionForRunSpec(runSpecId, records, options.updateRunSpecStatus !== false);
  return {
    runSpecId,
    ranRecordIds,
    records,
    decision,
  };
}

async function applyVerificationDecisionForRunSpec(
  runSpecId: string,
  records?: readonly VerificationRecord[],
  shouldUpdateStatus = true,
): Promise<VerificationCompletionDecision> {
  const verificationRecords = records ?? await listVerificationRecordsForRunSpec(runSpecId);
  const decision = resolveVerificationCompletionDecision(verificationRecords);
  if (shouldUpdateStatus) {
    const runSpec = await loadRunSpec(runSpecId);
    if (runSpec && runSpec.status !== 'failed' && runSpec.status !== 'cancelled') {
      await transitionExecutionState({
        entityType: 'run_spec',
        entityId: runSpecId,
        to: decision.status,
        reason: `verification_decision:${decision.status}`,
        sessionId: runSpec.sessionId,
      }).catch(() => undefined);
    }
  }
  return decision;
}

async function resolveVerificationCwd(record: VerificationRecord, explicitCwd?: string): Promise<string> {
  if (explicitCwd) return explicitCwd;
  if (record.runSpecId) {
    const runSpec = await loadRunSpec(record.runSpecId);
    if (runSpec?.workspaceRoot) return runSpec.workspaceRoot;
  }
  return process.cwd();
}

async function runVerificationCommand(command: string, input: {
  cwd: string;
  timeoutMs?: number;
  outputLimit?: number;
  env?: Record<string, string | undefined>;
}): Promise<VerificationCommandResult> {
  const started = Date.now();
  const outputLimit = normalizePositiveInteger(input.outputLimit) ?? 8_000;
  const timeoutMs = normalizePositiveInteger(input.timeoutMs) ?? 120_000;
  let output = '';
  let timedOut = false;

  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd: input.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...input.env,
      },
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const appendOutput = (chunk: Buffer): void => {
      output = boundedOutput(output + chunk.toString('utf8'), outputLimit);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);
    child.on('error', (err) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        command,
        cwd: input.cwd,
        exitCode: null,
        signal: null,
        durationMs,
        outputSummary: boundedOutput(output || message, outputLimit),
        error: message,
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - started;
      const error = timedOut
        ? `verification command timed out after ${timeoutMs}ms`
        : exitCode === 0
          ? undefined
          : `verification command exited with ${exitCode ?? 'unknown'}${signal ? ` signal=${signal}` : ''}`;
      resolve({
        command,
        cwd: input.cwd,
        exitCode,
        signal,
        durationMs,
        outputSummary: boundedOutput(output.trim() || (error ?? 'ok'), outputLimit),
        error,
      });
    });
  });
}

async function appendVerificationEvent(
  record: VerificationRecord,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendSessionEvent({
    sessionId: record.sessionId,
    type,
    payload: {
      verificationRecordId: record.id,
      runSpecId: record.runSpecId ?? null,
      taskRunId: record.taskRunId ?? null,
      checkName: record.checkName,
      required: record.required,
      ...payload,
    },
  }).catch(() => undefined);
}

function boundedOutput(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}
