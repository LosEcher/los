import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodexRuntimeHandle } from './runtime-adapter/index.js';
import {
  getExternalRuntimeCapabilities,
  runExternalRuntime,
  type ExternalRuntimeEvent,
} from './runtime-task.js';

function completedCodexHandle(input: {
  output?: string;
  exitCode?: number | null;
  spawnFailed?: boolean;
} = {}): CodexRuntimeHandle {
  const exitCode = input.exitCode ?? 0;
  const exited = Promise.resolve({ exitCode, signal: null });
  const output = input.output ?? 'bounded result';
  return {
    sessionId: 'runtime-completed-test',
    pid: 4242,
    kill: () => true,
    exited,
    output: Promise.resolve({
      exitCode,
      output,
      outputBytes: Buffer.byteLength(output),
      totalBytes: Buffer.byteLength(output),
      truncated: false,
      stderrBytes: 0,
      spawnFailed: input.spawnFailed ?? false,
    }),
  };
}

test('external runtime capability profiles separate runnable workers from planned adapters', () => {
  const profiles = getExternalRuntimeCapabilities({
    codex: { available: true },
    grok: { available: false, reason: 'grok_account_not_active' },
    claudeCode: { available: true },
  });
  assert.equal(profiles.find(profile => profile.kind === 'codex')?.implementation, 'runnable');
  assert.equal(profiles.find(profile => profile.kind === 'grok')?.unavailableReason, 'grok_account_not_active');
  assert.equal(profiles.find(profile => profile.kind === 'reasonix')?.implementation, 'planned');
  assert.equal(profiles.find(profile => profile.kind === 'pi-external')?.implementation, 'planned');
  assert.equal(profiles.find(profile => profile.kind === 'codex')?.routingHints.advisoryOnly, true);
});

test('external runtime abort kills the child and emits one cancelled terminal event', async () => {
  const controller = new AbortController();
  const events: ExternalRuntimeEvent[] = [];
  const persisted: ExternalRuntimeEvent[] = [];
  let killedWith: NodeJS.Signals | undefined;
  let resolveExit!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
    resolveExit = resolve;
  });
  const handle: CodexRuntimeHandle = {
    sessionId: 'runtime-cancel-test',
    pid: 4242,
    kill: signal => {
      killedWith = signal;
      resolveExit({ exitCode: null, signal: signal ?? null });
      return true;
    },
    exited,
    output: exited.then(() => ({
      exitCode: null,
      output: '',
      outputBytes: 0,
      totalBytes: 0,
      truncated: false,
      stderrBytes: 0,
      spawnFailed: false,
    })),
  };

  const result = await runExternalRuntime({
    kind: 'codex',
    prompt: 'inspect only',
    workspaceRoot: process.cwd(),
    signal: controller.signal,
    onEvent: event => {
      events.push(event);
      if (event.type === 'runtime.process') controller.abort();
    },
  }, {
    spawnCodex: () => handle,
    isOtelBridgeRunning: () => true,
    persistEvent: async event => { persisted.push(event); },
  });

  assert.equal(killedWith, 'SIGTERM');
  assert.equal(result.cancelled, true);
  assert.deepEqual(events.map(event => event.type), [
    'runtime.started',
    'runtime.process',
    'runtime.cancelled',
  ]);
  assert.deepEqual(persisted.map(event => event.type), events.map(event => event.type));
  assert.equal(events.at(-1)?.sequence, 3);
});

test('Codex execution continues when the optional OTel bridge cannot start', async () => {
  const events: ExternalRuntimeEvent[] = [];
  const result = await runExternalRuntime({
    kind: 'codex',
    prompt: 'return the review',
    workspaceRoot: process.cwd(),
    onEvent: event => { events.push(event); },
  }, {
    isOtelBridgeRunning: () => false,
    startOtelBridge: async () => { throw new Error('address in use'); },
    spawnCodex: input => {
      assert.equal(input.otelEndpoint, 'http://127.0.0.1:4318');
      return completedCodexHandle({ output: 'review result' });
    },
    persistEvent: async () => undefined,
  });

  assert.equal(result.content, 'review result');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(events.map(event => event.type), [
    'runtime.started',
    'runtime.process',
    'runtime.output',
    'runtime.completed',
  ]);
});

test('non-zero external runtime exit still emits bounded output and completed failure', async () => {
  const events: ExternalRuntimeEvent[] = [];
  const result = await runExternalRuntime({
    kind: 'codex',
    prompt: 'inspect failure',
    workspaceRoot: process.cwd(),
    onEvent: event => { events.push(event); },
  }, {
    isOtelBridgeRunning: () => true,
    spawnCodex: () => completedCodexHandle({ output: 'partial finding', exitCode: 7 }),
    persistEvent: async () => undefined,
  });

  assert.equal(result.content, 'partial finding');
  assert.match(result.error ?? '', /exited with code 7/);
  assert.equal(events.find(event => event.type === 'runtime.output')?.text, 'partial finding');
  assert.equal(events.at(-1)?.type, 'runtime.completed');
  assert.equal(events.at(-1)?.status, 'failed');
});

test('spawn failure emits runtime.error without a completed event', async () => {
  const events: ExternalRuntimeEvent[] = [];
  const result = await runExternalRuntime({
    kind: 'codex',
    prompt: 'inspect spawn',
    workspaceRoot: process.cwd(),
    onEvent: event => { events.push(event); },
  }, {
    isOtelBridgeRunning: () => true,
    spawnCodex: () => completedCodexHandle({ exitCode: null, spawnFailed: true }),
    persistEvent: async () => undefined,
  });

  assert.equal(result.spawnFailed, true);
  assert.deepEqual(events.map(event => event.type), [
    'runtime.started',
    'runtime.process',
    'runtime.error',
  ]);
});

test('event delivery failure terminates a spawned child before returning an error', async () => {
  let killedWith: NodeJS.Signals | undefined;
  let resolveExit!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
    resolveExit = resolve;
  });
  const handle: CodexRuntimeHandle = {
    sessionId: 'runtime-event-failure-test',
    pid: 4242,
    kill: signal => {
      killedWith = signal;
      resolveExit({ exitCode: null, signal: signal ?? null });
      return true;
    },
    exited,
    output: exited.then(() => ({
      exitCode: null,
      output: '',
      outputBytes: 0,
      totalBytes: 0,
      truncated: false,
      stderrBytes: 0,
      spawnFailed: false,
    })),
  };

  const result = await runExternalRuntime({
    kind: 'codex',
    prompt: 'inspect observer failure',
    workspaceRoot: process.cwd(),
  }, {
    isOtelBridgeRunning: () => true,
    spawnCodex: () => handle,
    persistEvent: async event => {
      if (event.type === 'runtime.process') throw new Error('event sink unavailable');
    },
  });

  assert.equal(killedWith, 'SIGTERM');
  assert.match(result.error ?? '', /runtime failed/);
});
