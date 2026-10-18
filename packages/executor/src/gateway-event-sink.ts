import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SessionEventRecord } from '@los/agent';

export interface GatewayEventSinkOptions {
  gatewayUrl: string;
  taskRunId: string;
  getToken: () => string | undefined;
  fetchImpl?: typeof fetch;
  batchSize?: number;
  flushDelayMs?: number;
  /** When set, each event is written to disk before it is queued. */
  spoolRoot?: string;
}

function fileNameFor(clientEventId: string): string {
  return `${clientEventId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

/**
 * Outbound event buffer for a no-DB executor.
 *
 * The queue is mirrored to disk when `spoolRoot` is set: write event → POST
 * batch → delete file only after 200. A process crash can therefore leave
 * replayable files instead of silently losing the event. The replay helper
 * uses a node credential, so it does not depend on an expired task token.
 */
export class GatewayEventSink {
  private queue: SessionEventRecord[] = [];
  private seq = 0;
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly taskDir?: string;

  constructor(private readonly options: GatewayEventSinkOptions) {
    this.taskDir = options.spoolRoot
      ? join(resolve(options.spoolRoot), encodeURIComponent(options.taskRunId))
      : undefined;
  }

  get backlog(): number {
    return this.queue.length;
  }

  async enqueue(event: SessionEventRecord): Promise<void> {
    const clientEventId = `${this.options.taskRunId}:${event.id}:${this.seq++}`;
    const record = { ...event, clientEventId } as SessionEventRecord;
    if (this.taskDir) {
      try {
        await mkdir(this.taskDir, { recursive: true });
        await writeFile(join(this.taskDir, fileNameFor(clientEventId)), JSON.stringify(record), 'utf8');
      } catch {
        // Memory queue still carries the event; health exposes backlog.
      }
    }
    this.queue.push(record);
    this.schedule();
  }

  async drain(timeoutMs = 10_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 && Date.now() < deadline) {
      await this.flush();
      if (this.queue.length > 0) await new Promise(resolve => setTimeout(resolve, 200));
    }
    return this.queue.length;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const token = this.options.getToken();
        if (!token) return;
        const batch = this.queue.slice(0, this.options.batchSize ?? 50);
        const res = await (this.options.fetchImpl ?? fetch)(
          `${this.options.gatewayUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(this.options.taskRunId)}/events`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-los-task-token': token },
            body: JSON.stringify({ events: batch }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) return;
        this.queue.splice(0, batch.length);
        if (this.taskDir) {
          await Promise.all(batch.map(async event => {
            const clientEventId = (event as SessionEventRecord & { clientEventId?: string }).clientEventId;
            if (clientEventId) await unlink(join(this.taskDir!, fileNameFor(clientEventId))).catch(() => undefined);
          }));
        }
      }
    } catch {
      // Keep the queue/files for the next flush or process-level replay.
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) this.schedule();
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.flushDelayMs ?? 200);
  }
}

/**
 * Replay spool files left by a previous process. Auth is the node credential,
 * not the expired task token; the gateway still checks the task's node id.
 */
export async function replayGatewayEventSpool(options: {
  spoolRoot: string;
  gatewayUrl: string;
  nodeCredential: string;
  nodeId: string;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const root = resolve(options.spoolRoot);
  let sent = 0;
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return 0;
  }
  for (const taskRunId of dirs) {
    const taskDir = join(root, taskRunId);
    let files: string[];
    try {
      files = (await readdir(taskDir)).filter(name => name.endsWith('.json'));
    } catch {
      continue;
    }
    for (let offset = 0; offset < files.length; offset += 50) {
      const batchFiles = files.slice(offset, offset + 50);
      const events = await Promise.all(batchFiles.map(async name => {
        try { return JSON.parse(await readFile(join(taskDir, name), 'utf8')) as Record<string, unknown>; } catch { return null; }
      }));
      const valid = events.filter((event): event is Record<string, unknown> => Boolean(event));
      if (valid.length === 0) continue;
      const res = await (options.fetchImpl ?? fetch)(
        `${options.gatewayUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(taskRunId)}/events`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-los-node-credential': options.nodeCredential },
          body: JSON.stringify({ events: valid }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) continue;
      await Promise.all(batchFiles.map(name => unlink(join(taskDir, name)).catch(() => undefined)));
      sent += valid.length;
    }
  }
  return sent;
}
