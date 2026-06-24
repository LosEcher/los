/**
 * @los/gateway/security-routes — Repo-owned security scanning endpoint.
 *
 * Delegates to an external tool (gitleaks, trufflehog, or secretlint) via
 * SECURITY_SCAN_CMD env var. Falls back to reporting that no external scanner
 * is configured, with a link to setup instructions.
 *
 * Replaces the inline SECRET_PATTERNS regex approach with a repo-owned
 * scan command that produces machine-readable output.
 */
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { getLogger } from '@los/infra/logger';
import { requireOperator } from '../../request-context.js';
import {
  normalizeOptionalString,
  normalizeOptionalNonNegativeInteger,
} from '../server-helpers.js';

const log = getLogger('security-routes');
const execFileAsync = promisify(execFile);

/** Resolve the security scan command from config or env */
function resolveScanCommand(): { cmd: string; args: string[] } | null {
  const envCmd = process.env.SECURITY_SCAN_CMD;
  if (envCmd) {
    // Support "gitleaks detect --no-git" or "trufflehog filesystem"
    const parts = envCmd.split(/\s+/).filter(Boolean);
    return { cmd: parts[0], args: parts.slice(1) };
  }
  return null;
}

/** Run the scan command against a directory, returning findings as structured JSON */
async function runSecurityScan(workspaceRoot: string): Promise<{
  ok: boolean;
  scanner: string | null;
  findings: Array<{ file: string; line?: number; rule: string; secret: string; message: string }>;
  error?: string;
}> {
  const scanCmd = resolveScanCommand();
  if (!scanCmd) {
    return {
      ok: true,
      scanner: null,
      findings: [],
      error: 'No SECURITY_SCAN_CMD configured. Set env var to gitleaks, trufflehog, or secretlint.',
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(scanCmd.cmd, [...scanCmd.args, workspaceRoot], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: workspaceRoot,
    });

    // Parse gitleaks/trufflehog JSON output
    const findings: Array<{ file: string; line?: number; rule: string; secret: string; message: string }> = [];
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        // gitleaks format: [{File, StartLine, RuleID, Secret, Description}]
        for (const item of parsed) {
          findings.push({
            file: item.File ?? item.file ?? item.SourceMetadata?.Data?.Filesystem?.file ?? 'unknown',
            line: item.StartLine ?? item.line ?? item.SourceMetadata?.Data?.Filesystem?.line,
            rule: item.RuleID ?? item.ruleId ?? item.DetectorName ?? 'unknown',
            secret: item.Secret ?? item.Raw ?? '',
            message: item.Description ?? item.detail ?? '',
          });
        }
      }
    } catch {
      // Non-JSON output — include raw text
    }

    return { ok: true, scanner: scanCmd.cmd, findings };
  } catch (err: any) {
    const stderr = err.stderr ?? '';
    const msg = err.message ?? String(err);
    log.warn(`Security scan failed (${scanCmd.cmd}): ${msg}`);
    return { ok: false, scanner: scanCmd.cmd, findings: [], error: stderr || msg };
  }
}

export function registerSecurityRoutes(app: FastifyInstance): void {
  app.get('/security/scan', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;

    const query = req.query as { path?: string; limit?: string };

    const scanPath = normalizeOptionalString(query.path) ?? resolve(process.cwd());
    const limit = normalizeOptionalNonNegativeInteger(query.limit) ?? 50;

    const result = await runSecurityScan(scanPath);
    return {
      ...result,
      findings: result.findings.slice(0, limit),
      scannedAt: new Date().toISOString(),
    };
  });

  app.get('/security/scan-config', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;

    const scanCmd = resolveScanCommand();
    return {
      configured: scanCmd !== null,
      scanner: scanCmd?.cmd ?? null,
      args: scanCmd?.args ?? null,
      setupInstructions: scanCmd
        ? null
        : 'Set SECURITY_SCAN_CMD env var. Examples:\n' +
          '  gitleaks:  SECURITY_SCAN_CMD="gitleaks detect --no-git --format json"\n' +
          '  trufflehog: SECURITY_SCAN_CMD="trufflehog filesystem --json"',
    };
  });
}
