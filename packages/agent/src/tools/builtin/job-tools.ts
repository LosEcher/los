/**
 * @los/agent/tools/job-tools — Background job management.
 *
 * run_background: spawn a long-running process, capture output.
 * job_output: read buffered output from a background job.
 * stop_job: kill a background job.
 * list_jobs: list all tracked jobs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolRegistry } from '../core/registry.js';
import { safeWorkspacePath } from '../core/path-safety.js';

// ── Job Manager ─────────────────────────────────────────

interface TrackedJob {
  id: number;
  command: string;
  cwd: string;
  pid: number | undefined;
  process: ChildProcess;
  output: string;
  exited: boolean;
  exitCode: number | null;
  startedAt: number;
}

let nextJobId = 1;
const jobs = new Map<number, TrackedJob>();

function createJob(command: string, cwd: string, proc: ChildProcess): TrackedJob {
  const id = nextJobId++;
  const job: TrackedJob = {
    id, command, cwd,
    pid: proc.pid,
    process: proc,
    output: '',
    exited: false,
    exitCode: null,
    startedAt: Date.now(),
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    job.output += chunk.toString('utf-8');
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    job.output += chunk.toString('utf-8');
  });
  proc.on('exit', (code) => {
    job.exited = true;
    job.exitCode = code;
  });
  proc.on('error', (err) => {
    job.output += `\n[process error: ${err.message}]\n`;
    job.exited = true;
    job.exitCode = -1;
  });

  jobs.set(id, job);

  // Auto-cleanup after 5 minutes of being stopped
  setTimeout(() => {
    const j = jobs.get(id);
    if (j && j.exited) jobs.delete(id);
  }, 300_000).unref();

  return job;
}

// ── run_background ──────────────────────────────────────

const STARTUP_TIMEOUT_MS = 3000;

export function registerRunBackgroundTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('run_background', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const command = String(args.command ?? '').trim();
    if (!command) return { content: '', error: 'command is required' };

    const cwd = safeWorkspacePath(
      options.workspaceRoot,
      typeof args.cwd === 'string' ? args.cwd : '.',
    );

    const proc = spawn(command, [], {
      cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const job = createJob(command, cwd, proc);

    // Wait briefly for startup output or error
    const startupOutput = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        resolve(job.output.slice(0, 500) || '(no output yet)');
      }, STARTUP_TIMEOUT_MS);

      // Also resolve early if process exits quickly
      proc.on('exit', () => {
        clearTimeout(timer);
        resolve(job.output.slice(0, 500) + (job.exitCode !== 0 ? `\n[exited with code ${job.exitCode}]` : ''));
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(`[spawn error: process failed to start]`);
      });
    });

    return {
      content: [
        `Job ${job.id} started (pid ${job.pid ?? '?'})`,
        `Command: ${command}`,
        `Cwd: ${cwd}`,
        `--- startup output ---`,
        startupOutput || '(no output)',
      ].join('\n'),
    };
  }, {
    type: 'function',
    function: {
      name: 'run_background',
      description:
        'Spawn a long-running shell command in the background. ' +
        'Returns job ID, pid, and early output. ' +
        'Use job_output to read more output, stop_job to kill. ' +
        'Use this for dev servers, watchers, builds, installs.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory (default: workspace root).' },
        },
        required: ['command'],
      },
    },
  }, {
    riskLevel: 'L2',
    permissions: ['workspace:shell'],
    timeoutMs: 10_000,
    retryable: false,
    idempotent: false,
    costLevel: 'medium',
    sideEffect: true,
    sandboxRequired: false,
    needsApproval: true,
    tags: ['shell', 'background'],
  });
}

// ── job_output ──────────────────────────────────────────

export function registerJobOutputTool(registry: ToolRegistry): void {
  registry.register('job_output', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const jobId = Number(args.jobId ?? -1);
    if (!Number.isFinite(jobId) || jobId < 1) {
      return { content: '', error: 'jobId is required (positive integer)' };
    }

    const job = jobs.get(jobId);
    if (!job) {
      return { content: '', error: `Job ${jobId} not found. It may have been cleaned up.` };
    }

    const tailLines = Number(args.tailLines ?? 80);
    const lines = job.output.split('\n');
    const tail = tailLines > 0 ? lines.slice(-tailLines).join('\n') : job.output;

    return {
      content: [
        `Job ${jobId} (pid ${job.pid ?? '?'}) — ${job.command}`,
        job.exited
          ? `Status: exited with code ${job.exitCode}`
          : `Status: running (${Math.round((Date.now() - job.startedAt) / 1000)}s)`,
        `Output (${lines.length} lines total):`,
        tail || '(no output)',
      ].join('\n'),
    };
  }, {
    type: 'function',
    function: {
      name: 'job_output',
      description:
        'Read the buffered output of a background job. ' +
        'Returns status (running/exited), output line count, and tail of output.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'number', description: 'Job id returned by run_background.' },
          tailLines: { type: 'number', description: 'Show last N lines of output. Default 80, 0 = all.' },
        },
        required: ['jobId'],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['workspace:read'],
    timeoutMs: 10_000,
    retryable: true,
    idempotent: true,
    costLevel: 'low',
    sideEffect: false,
    tags: ['shell', 'read'],
  });
}

// ── stop_job ────────────────────────────────────────────

export function registerStopJobTool(registry: ToolRegistry): void {
  registry.register('stop_job', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const jobId = Number(args.jobId ?? -1);
    if (!Number.isFinite(jobId) || jobId < 1) {
      return { content: '', error: 'jobId is required (positive integer)' };
    }

    const job = jobs.get(jobId);
    if (!job) {
      return { content: '', error: `Job ${jobId} not found or already cleaned up.` };
    }

    if (job.exited) {
      return { content: `Job ${jobId} already exited with code ${job.exitCode}` };
    }

    job.process.kill('SIGTERM');
    // Force kill after 3s if still alive
    setTimeout(() => {
      if (!job.exited) job.process.kill('SIGKILL');
    }, 3000).unref();

    return { content: `Sent SIGTERM to job ${jobId} (pid ${job.pid}). Use job_output to confirm exit.` };
  }, {
    type: 'function',
    function: {
      name: 'stop_job',
      description:
        'Stop a background job. Sends SIGTERM first, then SIGKILL after 3s if still alive.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'number', description: 'Job id returned by run_background.' },
        },
        required: ['jobId'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['workspace:shell'],
    timeoutMs: 10_000,
    retryable: false,
    idempotent: true,
    costLevel: 'low',
    sideEffect: true,
    tags: ['shell'],
  });
}

// ── list_jobs ───────────────────────────────────────────

export function registerListJobsTool(registry: ToolRegistry): void {
  registry.register('list_jobs', async () => {
    if (jobs.size === 0) {
      return { content: 'No background jobs.' };
    }

    const lines: string[] = [];
    for (const job of jobs.values()) {
      const status = job.exited
        ? `exited (${job.exitCode})`
        : `running (${Math.round((Date.now() - job.startedAt) / 1000)}s)`;
      lines.push(`${job.id}\tpid ${job.pid ?? '?'}\t${status}\t${job.command}`);
    }

    return { content: `ID\tPID\tSTATUS\tCOMMAND\n${lines.join('\n')}` };
  }, {
    type: 'function',
    function: {
      name: 'list_jobs',
      description:
        'List all tracked background jobs with id, pid, status, and command.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['workspace:read'],
    timeoutMs: 5_000,
    retryable: true,
    idempotent: true,
    costLevel: 'low',
    sideEffect: false,
    tags: ['shell', 'read'],
  });
}

// ── Bulk Registration ───────────────────────────────────

export function registerJobTools(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registerRunBackgroundTool(registry, options);
  registerJobOutputTool(registry);
  registerStopJobTool(registry);
  registerListJobsTool(registry);
}
