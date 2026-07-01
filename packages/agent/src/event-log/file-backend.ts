/**
 * @los/agent/event-log/file-backend — File-based append-only event log.
 *
 * Stores each stream as a JSONL file at ~/.los/streams/<stream>/events.jsonl.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getLogger } from '@los/infra/logger';
import type {
  EventLogBackend,
  EventLogEntry,
  AppendEventInput,
  ReadEventsOptions,
  EventLogStats,
} from './types.js';

const log = getLogger('event-log-file');

const DEFAULT_BASE_DIR = '.los/streams';

let _baseDir: string | null = null;

export function setEventLogBaseDir(dir: string): void {
  _baseDir = dir;
}

function getBaseDir(): string {
  return _baseDir ?? join(process.cwd(), DEFAULT_BASE_DIR);
}

// ── Index type ──────────────────────────────────────────────

interface StreamIndex {
  lastId: number;
  sizeBytes: number;
}

// ── Backend ────────────────────────────────────────────────

export class FileEventLogBackend implements EventLogBackend {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? getBaseDir();
  }

  async append(stream: string, events: AppendEventInput[]): Promise<number[]> {
    if (events.length === 0) return [];

    const logPath = this.logPath(stream);
    ensureDir(dirname(logPath));

    const index = this.readIndex(stream);
    let nextId = index.lastId + 1;
    const now = new Date().toISOString();
    const ids: number[] = [];

    const lines: string[] = [];
    for (const evt of events) {
      const entry: EventLogEntry = {
        id: nextId,
        stream,
        type: evt.type,
        timestamp: evt.timestamp ?? now,
        payload: evt.payload ?? {},
      };
      lines.push(JSON.stringify(entry));
      ids.push(nextId);
      nextId++;
    }

    try {
      appendFileSync(logPath, lines.join('\n') + '\n');
    } catch (err) {
      log.warn(`Failed to append to event log "${stream}": ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    const newSize = (index.sizeBytes ?? 0) + lines.join('\n').length + 1;
    this.writeIndex(stream, { lastId: nextId - 1, sizeBytes: newSize });

    return ids;
  }

  async read(stream: string, opts: ReadEventsOptions = {}): Promise<EventLogEntry[]> {
    const logPath = this.logPath(stream);
    if (!existsSync(logPath)) return [];

    const fromId = opts.fromId ?? 0;
    const limit = opts.limit ?? 1000;
    const typeFilter = opts.type;
    const results: EventLogEntry[] = [];

    try {
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        if (results.length >= limit) break;
        try {
          const entry = JSON.parse(line) as EventLogEntry;
          if (entry.id <= fromId) continue;
          if (typeFilter && entry.type !== typeFilter) continue;
          results.push(entry);
        } catch { /* skip corrupt lines */ }
      }
    } catch (err) {
      log.warn(`Failed to read "${stream}": ${err instanceof Error ? err.message : String(err)}`);
    }

    return results;
  }

  async getLastEventId(stream: string): Promise<number> {
    return this.readIndex(stream).lastId;
  }

  async getStats(stream: string): Promise<EventLogStats> {
    const logPath = this.logPath(stream);
    const index = this.readIndex(stream);
    let firstEventAt: string | null = null;
    let lastEventAt: string | null = null;

    if (existsSync(logPath)) {
      try {
        const content = readFileSync(logPath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length > 0) {
          firstEventAt = (JSON.parse(lines[0]) as EventLogEntry).timestamp;
          lastEventAt = (JSON.parse(lines[lines.length - 1]) as EventLogEntry).timestamp;
        }
      } catch { /* ok */ }
    }

    return {
      stream,
      totalEvents: index.lastId,
      firstEventAt,
      lastEventAt,
      sizeBytes: index.sizeBytes ?? (existsSync(logPath) ? readFileSync(logPath).length : 0),
    };
  }

  async truncate(stream: string): Promise<void> {
    const logPath = this.logPath(stream);
    const indexPath = this.indexPath(stream);
    try {
      if (existsSync(logPath)) unlinkSync(logPath);
      if (existsSync(indexPath)) unlinkSync(indexPath);
    } catch (err) {
      log.warn(`Failed to truncate "${stream}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Paths ─────────────────────────────────────────────────

  private streamDir(stream: string): string {
    const safe = stream.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.baseDir, safe);
  }

  private logPath(stream: string): string {
    return join(this.streamDir(stream), 'events.jsonl');
  }

  private indexPath(stream: string): string {
    return join(this.streamDir(stream), 'index.json');
  }

  // ── Index ─────────────────────────────────────────────────

  private readIndex(stream: string): StreamIndex {
    const indexPath = this.indexPath(stream);
    if (!existsSync(indexPath)) return { lastId: 0, sizeBytes: 0 };
    try {
      return JSON.parse(readFileSync(indexPath, 'utf-8')) as StreamIndex;
    } catch {
      return this.rebuildIndex(stream);
    }
  }

  private writeIndex(stream: string, index: StreamIndex): void {
    const indexPath = this.indexPath(stream);
    ensureDir(dirname(indexPath));
    try {
      writeFileSync(indexPath, JSON.stringify(index), 'utf-8');
    } catch { /* best-effort */ }
  }

  private rebuildIndex(stream: string): StreamIndex {
    const logPath = this.logPath(stream);
    if (!existsSync(logPath)) return { lastId: 0, sizeBytes: 0 };
    try {
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let lastId = 0;
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as EventLogEntry;
          if (e.id > lastId) lastId = e.id;
        } catch { /* skip */ }
      }
      const idx: StreamIndex = { lastId, sizeBytes: Buffer.byteLength(content) };
      this.writeIndex(stream, idx);
      return idx;
    } catch {
      return { lastId: 0, sizeBytes: 0 };
    }
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
