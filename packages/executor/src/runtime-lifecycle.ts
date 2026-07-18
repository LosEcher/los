import type { Server } from 'node:http';
import { getLogger } from '@los/infra/logger';

const log = getLogger('executor');

export type ExecutorRuntimeStatus = 'online' | 'draining' | 'offline';

export interface ActiveExecutorTask {
  controller: AbortController;
  finish(): void;
}

export class ExecutorRuntimeLifecycle {
  private statusValue: ExecutorRuntimeStatus = 'online';
  private readonly activeControllers = new Set<AbortController>();
  private readonly idleWaiters = new Set<() => void>();

  get status(): ExecutorRuntimeStatus {
    return this.statusValue;
  }

  get acceptingTasks(): boolean {
    return this.statusValue === 'online';
  }

  get activeTaskCount(): number {
    return this.activeControllers.size;
  }

  startTask(): ActiveExecutorTask | null {
    if (!this.acceptingTasks) return null;

    const controller = new AbortController();
    this.activeControllers.add(controller);
    let finished = false;
    return {
      controller,
      finish: () => {
        if (finished) return;
        finished = true;
        this.activeControllers.delete(controller);
        if (this.activeControllers.size === 0) {
          for (const resolve of this.idleWaiters) resolve();
          this.idleWaiters.clear();
        }
      },
    };
  }

  beginDrain(): void {
    if (this.statusValue === 'online') this.statusValue = 'draining';
  }

  markOffline(): void {
    this.statusValue = 'offline';
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.activeControllers.size === 0) return true;
    if (timeoutMs <= 0) return false;

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.idleWaiters.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      this.idleWaiters.add(onIdle);
    });
  }

  abortAll(reason: Error): void {
    for (const controller of this.activeControllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }
}

export async function shutdownExecutor(input: {
  server: Server;
  lifecycle: ExecutorRuntimeLifecycle;
  shutdownGraceMs: number;
  stopHeartbeat: () => void;
  stopPeriodicSync: () => void;
  writeHeartbeat: () => Promise<void>;
}): Promise<void> {
  input.lifecycle.beginDrain();
  log.info(`Executor draining for up to ${input.shutdownGraceMs}ms; active=${input.lifecycle.activeTaskCount}`);
  await input.writeHeartbeat().catch(err => log.warn(`draining heartbeat failed: ${err?.message ?? String(err)}`));

  const drained = await input.lifecycle.waitForIdle(input.shutdownGraceMs);
  if (!drained) {
    log.warn(`Executor shutdown grace expired; aborting ${input.lifecycle.activeTaskCount} active task(s)`);
    input.lifecycle.abortAll(new Error(`executor shutdown grace expired after ${input.shutdownGraceMs}ms`));
    await input.lifecycle.waitForIdle(5_000);
  }

  input.stopHeartbeat();
  input.stopPeriodicSync();
  input.lifecycle.markOffline();
  await input.writeHeartbeat().catch(err => log.warn(`offline heartbeat failed: ${err?.message ?? String(err)}`));
  await closeHttpServer(input.server, 5_000);
  log.info('Executor stopped');
}

async function closeHttpServer(server: Server, timeoutMs: number): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveClose();
    };
    const timeout = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, timeoutMs);
    timeout.unref?.();
    server.close(finish);
    server.closeIdleConnections();
  });
}
