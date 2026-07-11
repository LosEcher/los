import { totalmem, freemem } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface ResourceMetrics {
  memoryTotalMb?: number;
  memoryAvailableMb?: number;
  swapTotalMb?: number;
  swapUsedMb?: number;
  diskFreeGb?: number;
  psiMemorySome?: number;
  psiMemoryFull?: number;
  psiIoSome?: number;
  psiIoFull?: number;
}

export function collectResourceMetrics(): ResourceMetrics {
  const metrics: ResourceMetrics = {};
  try {
    const memoryTotalBytes = totalmem();
    metrics.memoryTotalMb = Math.round(memoryTotalBytes / (1024 * 1024));
    const memoryAvailableBytes = resolveAvailableMemoryBytes(memoryTotalBytes);
    if (memoryAvailableBytes !== undefined) {
      metrics.memoryAvailableMb = Math.round(memoryAvailableBytes / (1024 * 1024));
    }
  } catch { /* non-Linux or permission issue */ }

  if (process.platform === 'linux') {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf-8');
      const swapTotal = meminfo.match(/^SwapTotal:\s+(\d+)/m);
      const swapFree = meminfo.match(/^SwapFree:\s+(\d+)/m);
      if (swapTotal) {
        const totalKb = parseInt(swapTotal[1], 10);
        const freeKb = swapFree ? parseInt(swapFree[1], 10) : 0;
        metrics.swapTotalMb = Math.round(totalKb / 1024);
        metrics.swapUsedMb = Math.round((totalKb - freeKb) / 1024);
      }
    } catch { /* no /proc/meminfo */ }

    for (const field of ['/proc/pressure/memory', '/proc/pressure/io'] as const) {
      try {
        if (existsSync(field)) {
          const content = readFileSync(field, 'utf-8');
          const fullMatch = content.match(/full avg10=(\d+\.\d+)/);
          if (fullMatch) {
            if (field.includes('memory')) {
              metrics.psiMemoryFull = parseFloat(fullMatch[1]);
            } else {
              metrics.psiIoFull = parseFloat(fullMatch[1]);
            }
          }
        }
      } catch { /* permission or missing */ }
    }
  }
  return metrics;
}

function resolveAvailableMemoryBytes(memoryTotalBytes: number): number | undefined {
  if (process.platform !== 'darwin') return freemem();

  try {
    const output = execFileSync('/usr/bin/memory_pressure', [], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return _parseDarwinAvailableMemoryBytes(output, memoryTotalBytes);
  } catch {
    return undefined;
  }
}

export function _parseDarwinAvailableMemoryBytes(
  output: string,
  memoryTotalBytes: number,
): number | undefined {
  const match = output.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/);
  if (!match) return undefined;
  const percentAvailable = Number(match[1]);
  if (!Number.isFinite(percentAvailable) || percentAvailable < 0 || percentAvailable > 100) return undefined;
  return Math.round(memoryTotalBytes * percentAvailable / 100);
}

export function resolveResourceCapabilities(): Partial<Record<string, unknown>> {
  try {
    const memTotalMb = Math.round(totalmem() / (1024 * 1024));
    const isConstrained = memTotalMb <= 2048;

    if (process.platform === 'linux') {
      let swapTotalMb = 0;
      try {
        const meminfo = readFileSync('/proc/meminfo', 'utf-8');
        const m = meminfo.match(/^SwapTotal:\s+(\d+)/m);
        if (m) swapTotalMb = Math.round(parseInt(m[1], 10) / 1024);
      } catch { /* ignore */ }

      return {
        deploy_safe: !isConstrained || swapTotalMb >= 2048,
        heavy_task_safe: !isConstrained,
      };
    }

    // darwin / win32: evaluate from total memory without swap info.
    // macOS and Windows report totalmem() in bytes via node:os.
    return {
      deploy_safe: !isConstrained,
      heavy_task_safe: memTotalMb > 4096,
    };
  } catch {
    return {};
  }
}
