import type { SessionEventRecord } from '@los/agent';

export interface GatewayEventSinkOptions {
  gatewayUrl: string;
  taskRunId: string;
  getToken: () => string | undefined;
  fetchImpl?: typeof fetch;
  batchSize?: number;
  flushDelayMs?: number;
}

/**
 * Durable-ish outbound event buffer for a no-DB executor.
 *
 * Events are queued immediately and posted in batches. `drain()` is awaited
 * before a task returns, so a normal run does not end with an empty gateway
 * event stream. If the gateway is down, the queue remains and `backlog` is
 * exposed through executor health; this is deliberately not a silent drop.
 */
export class GatewayEventSink {
  private queue: SessionEventRecord[] = [];
  private seq = 0;
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: GatewayEventSinkOptions) {}

  get backlog(): number {
    return this.queue.length;
  }

  enqueue(event: SessionEventRecord): void {
    this.queue.push({
      ...event,
      clientEventId: `${this.options.taskRunId}:${event.id}:${this.seq++}`,
    } as SessionEventRecord);
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
      }
    } catch {
      // Keep the queue for the next flush/drain; health exposes the backlog.
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
