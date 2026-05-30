import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

type LogRoutesOptions = {
  runtimeLogDir: string;
  runtimeLogPath: string;
};

type LogEntry = {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  package?: string;
  message: string;
  raw: string;
};

export function registerLogRoutes(app: FastifyInstance, options: LogRoutesOptions) {
  app.get('/logs/files', async () => {
    return listLogFiles(options.runtimeLogDir);
  });

  app.get('/logs', async (req) => {
    const { file, level, q, lines } = req.query as { file?: string; level?: string; q?: string; lines?: string };
    const fileInfo = resolveLogFile(file, options);
    const limit = normalizePositiveInteger(lines) ?? 120;
    const entries = readLogEntries(fileInfo.path, {
      level,
      query: q,
      limit,
    });
    return {
      file: fileInfo.name,
      path: fileInfo.path,
      count: entries.length,
      entries,
    };
  });
}

function listLogFiles(runtimeLogDir: string): Array<{ name: string; path: string; size: number; modifiedAt: string }> {
  if (!existsSync(runtimeLogDir)) return [];
  return readdirSync(runtimeLogDir)
    .filter(entry => entry.endsWith('.log'))
    .map((name) => {
      const path = join(runtimeLogDir, name);
      const stat = statSync(path);
      return {
        name,
        path,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function resolveLogFile(file: string | undefined, options: LogRoutesOptions): { name: string; path: string } {
  const available = listLogFiles(options.runtimeLogDir);
  if (available.length === 0) {
    return { name: 'gateway.log', path: options.runtimeLogPath };
  }

  if (file) {
    const normalized = file.trim();
    const matched = available.find(entry => entry.name === normalized || entry.name.replace(/\.log$/, '') === normalized);
    if (matched) return { name: matched.name, path: matched.path };
  }

  return { name: available[0]!.name, path: available[0]!.path };
}

function readLogEntries(path: string, opts: { level?: string; query?: string; limit: number }): LogEntry[] {
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean);

  const levelFilter = normalizeOptionalString(opts.level)?.toLowerCase();
  const query = normalizeOptionalString(opts.query)?.toLowerCase();
  const slice = lines.slice(Math.max(0, lines.length - opts.limit));
  const out: LogEntry[] = [];

  for (const line of slice) {
    const parsed = parseLogLine(line);
    if (!parsed) continue;
    if (levelFilter && parsed.level !== levelFilter) continue;
    if (query) {
      const haystack = `${parsed.timestamp} ${parsed.package ?? ''} ${parsed.message} ${parsed.raw}`.toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    out.push(parsed);
  }

  return out;
}

function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        timestamp: String(entry.timestamp ?? ''),
        level: normalizeLogLevel(entry.level),
        package: normalizeOptionalString(entry.package),
        message: String(entry.message ?? trimmed),
        raw: trimmed,
      };
    } catch {
      return {
        timestamp: '',
        level: 'info',
        message: trimmed,
        raw: trimmed,
      };
    }
  }

  const match = trimmed.match(/^\[(?<time>\d{2}:\d{2}:\d{2})\]\s+(?<level>DEBUG|INFO|WARN|ERROR)\s+(?:\[(?<pkg>[^\]]+)\]\s+)?(?<message>.*)$/);
  if (match?.groups) {
    const timestamp = `${new Date().toISOString().slice(0, 10)}T${match.groups.time}Z`;
    return {
      timestamp,
      level: normalizeLogLevel(match.groups.level),
      package: match.groups.pkg,
      message: match.groups.message ?? '',
      raw: trimmed,
    };
  }

  return {
    timestamp: '',
    level: 'info',
    message: trimmed,
    raw: trimmed,
  };
}

function normalizeLogLevel(value: unknown): 'debug' | 'info' | 'warn' | 'error' {
  const level = String(value ?? '').toLowerCase();
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') return level;
  if (level === 'warning') return 'warn';
  return 'info';
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    const int = Math.floor(parsed);
    return int > 0 ? int : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}
