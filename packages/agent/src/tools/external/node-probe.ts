/**
 * @los/agent/tools/external/node-probe — hash-pinned read-only network probe
 * runner support (run_node_probe tool).
 *
 * The sandbox replacement for Windows executor nodes where run_shell is
 * fail-closed (restricting-SID sandboxing is blocked at the mechanism level
 * in the los service-session environment — see shell-sandbox-windows.ts and
 * tools/windows-sandbox/los-probe-runner.cs): only probe scripts whose
 * SHA-256 matches a pin are executed, read-only, under a kill-on-close Job
 * Object. Isolation guarantee = pinned read-only script, not OS token
 * isolation. Win supervisor = los-probe-runner.exe; Linux supervisor =
 * los-probe-run.sh. Probe scripts live in tools/node-probes/.
 */

import { execFile } from 'node:child_process';
import type { ToolResult } from '../core/registry-policy.js';

/** Run the probe supervisor process and return its raw stdout. */
export function runProbeProcess(
  command: string,
  args: string[],
  timeoutSec = 130,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutSec * 1000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf-8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message || err)));
        else resolve(String(stdout));
      },
    );
  });
}

/** Interpret the runner JSON envelope into a ToolResult. */
export function probeResult(raw: string): ToolResult {
  try {
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      error?: string;
      output?: string;
      exit_code?: number;
      script?: string;
      sha256?: string;
    };
    if (parsed.error) {
      return { content: raw, error: parsed.error };
    }
    return { content: parsed.output ?? raw };
  } catch {
    return { content: raw };
  }
}
