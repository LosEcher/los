/**
 * @los/agent/tools/external/shell-sandbox-windows — Windows shell-sandbox
 * backends for los (RunSeal reference backend + zero-elevation restricted-token
 * ACL backend). Split out of shell-sandbox.ts to keep that file under the
 * module-size gate.
 *
 * - `windows-runseal`: RunSeal (runseal-labs, Apache-2.0) first-class Windows
 *   sandbox (AppContainer + restricted token + WFP). Requires one-time elevated
 *   setup (`runseal setup windows-sandbox --elevate`). As of 2026-08-17 the
 *   vendored backend failed on the pilot node (STATUS_DLL_INIT_FAILED /
 *   elevated-broker hang); gated behind agent.windowsSandboxBackend='runseal'.
 * - `windows-acl`: @deepseek-ai/dsh-sandbox-windows-acl (BSD-3-Clause, DeepSeek
 *   Harness sandbox seam): WRITE_RESTRICTED token whose restricting SIDs allow
 *   writes only into the workspace + a private temp dir (capability-SID ACEs).
 *   Zero admin, no desktop/broker machinery — restricts WRITES only (reads,
 *   network, process visibility unrestricted): the "read-only diagnostic +
 *   ping/curl" threat model.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { getConfig } from '@los/infra/config';
import { getLogger } from '@los/infra/logger';

import { buildSandboxEnv, type SandboxMode } from './shell-sandbox.js';

const log = getLogger('agent');
const require = createRequire(import.meta.url);

/** Windows sandbox backend preference (wired to config agent.windowsSandboxBackend). */
export type WindowsSandboxBackendPreference = 'auto' | 'runseal' | 'acl';

/** True when the @deepseek-ai/dsh-sandbox-windows-acl package resolves from this module. */
export function resolveWindowsAclModule(): string | null {
  try {
    return require.resolve('@deepseek-ai/dsh-sandbox-windows-acl');
  } catch {
    return null;
  }
}

/**
 * Resolve the configured Windows backend preference (config agent.windowsSandboxBackend).
 * Safe default 'acl' — the zero-elevation restricted-token backend.
 */
export function windowsPreference(): WindowsSandboxBackendPreference {
  try {
    return getConfig().agent?.windowsSandboxBackend ?? 'acl';
  } catch {
    return 'acl';
  }
}

function findExecutable(path: string): string | null {
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

/** Map los sandboxMode onto RunSeal policy levels. */
export function _runSealPolicyName(sandboxMode: SandboxMode): string {
  if (sandboxMode === 'readonly') return 'read-only';
  return 'workspace-write';
}

/** Map los sandboxNetwork onto RunSeal network modes. */
export function _runSealNetworkName(networkMode: 'isolated' | 'host'): string {
  return networkMode === 'isolated' ? 'disabled' : 'unmanaged';
}

export async function runWithRunSeal(
  input: { command: string; cwd: string; timeoutMs: number },
  sandboxMode: SandboxMode,
  networkMode: 'isolated' | 'host',
): Promise<{ content: string; error?: string; sandbox: string }> {
  const runseal = findExecutable('runseal.exe') ?? 'runseal.exe';
  const args = [
    'exec', '--json',
    '--policy', _runSealPolicyName(sandboxMode),
    '--network', _runSealNetworkName(networkMode),
    '--cwd', input.cwd,
    '--timeout-ms', String(input.timeoutMs),
    '--',
    'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', input.command,
  ];
  return new Promise((resolve) => {
    execFile(runseal, args, {
      timeout: input.timeoutMs + 10_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      env: buildSandboxEnv(),
    }, (err, stdout, stderr) => {
      const raw = String(stdout || stderr || '');
      // RunSeal --json prints a JSON envelope; extract the child's output
      // defensively since the shape is pre-1.0 and may change.
      let content = raw;
      let error = err ? String(stderr || err.message) : undefined;
      try {
        const parsed = JSON.parse(raw) as {
          stdout?: string | { toString(): string };
          stderr?: string | { toString(): string };
          exit_code?: number;
          message?: string;
        };
        if (parsed.stdout !== undefined) content = String(parsed.stdout);
        if (parsed.stderr) error = String(parsed.stderr);
        if (parsed.message) error = parsed.message;
        if (parsed.exit_code !== undefined && parsed.exit_code !== 0 && !error) {
          error = `command exited with code ${parsed.exit_code}`;
        }
      } catch { /* non-JSON output — keep raw */ }
      resolve({ content, error, sandbox: 'windows-runseal' });
    });
  });
}

export async function runWithWindowsAcl(
  input: { command: string; cwd: string; timeoutMs: number },
  sandboxMode: SandboxMode,
): Promise<{ content: string; error?: string; sandbox: string }> {
  try {
    const mod = await import('@deepseek-ai/dsh-sandbox-windows-acl');
    const canonical = realpathSync.native(input.cwd);
    const mode: 'read-only' | 'workspace-write' = sandboxMode === 'readonly' ? 'read-only' : 'workspace-write';
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    let tempDir: string | null = null;
    let sandbox: InstanceType<typeof mod.AclSandbox> | undefined;
    try {
      if (mode === 'workspace-write') {
        tempDir = mkdtempSync(join(tmpdir(), 'los-sandbox-'));
      }
      sandbox = new mod.AclSandbox(mode === 'read-only'
        ? { mode, writableDirs: [], tempDir: null }
        : {
            mode,
            writableDirs: [canonical],
            tempDir,
            writeSid: mod.workspaceWriteSid(canonical),
            tempWriteSid: mod.tempWriteSid(tempDir!),
          });
      await sandbox.init();
      const child = sandbox.spawn({
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', input.command],
        cwd: input.cwd,
        stdio: 'pipe',
      });
      const result = await waitForAclChild(child, input.timeoutMs);
      return {
        content: result.stdout.toString(),
        error: result.exitCode !== 0 ? result.stderr.toString() : undefined,
        sandbox: 'windows-acl',
      };
    } finally {
      try { sandbox?.dispose(); } catch { /* best-effort cleanup */ }
      if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`windows-acl sandbox failed: ${message}`);
    return {
      content: '',
      error: `windows-acl sandbox unavailable or failed (fail-closed): ${message}`,
      sandbox: 'windows-acl',
    };
  }
}

async function waitForAclChild(
  child: { pid: number; wait(): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> },
  timeoutMs: number,
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`windows-acl sandbox command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return await Promise.race([child.wait(), timeout]);
}
