import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { ConfigSchema, getConfig, setConfig } from '@los/infra/config';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { _consumeExecutionKernel, type KernelEvent } from './execution-kernel.js';
import { _createPiExecutionKernel } from './pi-execution-kernel.js';
import { _preparePiKernelRun, _projectPiProviderTelemetry } from './pi-kernel-input.js';
import type { AgentResult } from './loop.js';

const fixedNow = () => new Date('2026-07-22T00:00:00.000Z');

test('Pi input maps the LOS route, credential, messages, and governed tool catalog', async t => {
  configureFixtureProvider(t, {
    apiKey: 'configured-key',
    baseUrl: 'https://fixture.invalid/v1',
    model: 'fixture-model',
  });
  const credentials: string[] = [];
  const prepared = await _preparePiKernelRun('new request', baseConfig({
    initialMessages: [{ role: 'user', content: 'earlier request' }],
    allowedTools: ['read_file'],
  }), {
    now: fixedNow,
    resolveCredential: async provider => {
      credentials.push(provider);
      return { apiKey: 'runtime-key', baseUrl: 'https://runtime.invalid/v1' };
    },
  });
  t.after(prepared.cleanup);

  assert.deepEqual(prepared.route, {
    provider: 'fixture',
    model: 'fixture-model',
    api: 'openai-completions',
    configuredBaseUrl: 'https://fixture.invalid/v1',
    effectiveBaseUrl: 'https://runtime.invalid/v1',
    toolNames: ['read_file'],
  });
  assert.deepEqual(prepared.input.initialMessages, [{
    role: 'user',
    content: 'earlier request',
    timestamp: fixedNow().getTime(),
  }]);
  assert.equal(prepared.input.maxTurns, 3);
  assert.equal(typeof prepared.input.toolCatalog?.[0]?.parallelizable, 'boolean');
  assert.equal(prepared.input.toolCatalog?.some(tool => tool.name === 'spawn_agent'), false);
  assert.deepEqual(credentials, ['fixture']);
});

test('Pi provider stream records LOS-owned call telemetry', async () => {
  const source = createAssistantMessageEventStream();
  const final = fauxAssistantMessage('telemetry');
  const model = { ...createFixtureModel(), provider: 'fixture', id: 'fixture-model' };
  const records: Array<{ provider: string; model: string; status: number; endpoint: string }> = [];
  const projected = _projectPiProviderTelemetry(
    source,
    model,
    Date.now(),
    () => 201,
    {
      traceId: 'trace-telemetry',
      sessionId: 'session-telemetry',
      record: async record => {
        records.push({
          provider: record.provider,
          model: record.model,
          status: record.status,
          endpoint: record.endpoint,
        });
      },
    },
  );
  source.push({ type: 'done', reason: 'stop', message: final });
  for await (const _event of projected) {
    // Drain the wrapper so it can settle and write telemetry.
  }
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(records, [{
    provider: 'fixture',
    model: 'fixture-model',
    status: 201,
    endpoint: `pi:${model.api}`,
  }]);
});

test('Pi input and adapter form a deterministic scheduler-shaped compatibility probe', async t => {
  configureFixtureProvider(t, {
    apiKey: 'fixture-key',
    baseUrl: 'https://fixture.invalid/v1',
    model: 'fixture-model',
  });
  const faux = fauxProvider({ tokensPerSecond: 0 });
  faux.setResponses([fauxAssistantMessage('mapped')]);
  const prepared = await _preparePiKernelRun('probe', baseConfig(), {
    now: fixedNow,
    resolveCredential: async () => ({ apiKey: 'fixture-key' }),
  });
  t.after(prepared.cleanup);
  prepared.input.model = faux.getModel();
  prepared.input.streamFn = faux.provider.streamSimple.bind(faux.provider);
  const events: KernelEvent[] = [];

  const consumed = await _consumeExecutionKernel<typeof prepared.input, AgentResult>(
    _createPiExecutionKernel({ now: fixedNow }),
    prepared.input,
    event => { events.push(event); },
  );

  assert.equal(consumed.result.text, 'mapped');
  assert.equal(events.at(-1)?.type, 'kernel.finished');
  assert.deepEqual(events.map(event => event.sequence), events.map((_event, index) => index));
});

test('Pi input executes its mapped catalog through the production LOS ToolBroker', async t => {
  configureFixtureProvider(t, {
    apiKey: 'fixture-key',
    baseUrl: 'https://fixture.invalid/v1',
    model: 'fixture-model',
  });
  const faux = fauxProvider({ tokensPerSecond: 0 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read_file', { path: 'package.json' }, { id: 'mapped-call' }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('inspected'),
  ]);
  const prepared = await _preparePiKernelRun('inspect package', baseConfig({
    allowedTools: ['read_file'],
    workspaceRoot: process.cwd(),
  }), {
    resolveCredential: async () => ({ apiKey: 'fixture-key' }),
  });
  t.after(prepared.cleanup);
  prepared.input.model = faux.getModel();
  prepared.input.streamFn = faux.provider.streamSimple.bind(faux.provider);
  const events: KernelEvent[] = [];

  const consumed = await _consumeExecutionKernel<typeof prepared.input, AgentResult>(
    _createPiExecutionKernel({ now: fixedNow }),
    prepared.input,
    event => { events.push(event); },
  );

  assert.equal(consumed.result.text, 'inspected');
  assert.equal(events.find(event => event.type === 'tool.requested')?.toolCallId, 'mapped-call');
  assert.equal(
    (events.find(event => event.type === 'tool.completed')?.payload.transition as { state: string }).state,
    'succeeded',
  );
});

test('Pi input fails closed for unsupported lifecycle and model settings', async t => {
  configureFixtureProvider(t, {
    apiKey: 'fixture-key',
    baseUrl: 'https://fixture.invalid/v1',
    model: 'fixture-model',
  });

  await assert.rejects(
    _preparePiKernelRun('probe', baseConfig({
      providerFallback: {
        mode: 'explicit_ordered',
        targets: [{ provider: 'fixture' }, { provider: 'backup' }],
        onFailure: ['transport'],
        requireCompatibilityEvidence: false,
        maxSwitches: 1,
      },
    })),
    /provider fallback mapping is not implemented/,
  );
  await assert.rejects(
    _preparePiKernelRun('probe', baseConfig({ modelSettings: { topP: 0.9 } })),
    /topP or penalty model settings/,
  );
  await assert.rejects(
    _preparePiKernelRun('probe', baseConfig({ modelSettings: { reasoningEffort: 'none' } })),
    /reasoning disablement/,
  );
});

function baseConfig(overrides: Partial<Parameters<typeof _preparePiKernelRun>[1]> = {}) {
  return {
    taskRunId: 'task-pi-input',
    sessionId: 'session-pi-input',
    traceId: 'trace-pi-input',
    runSpecId: 'run-pi-input',
    provider: 'fixture',
    model: 'fixture-model',
    systemPrompt: 'LOS system prompt',
    toolMode: 'read-only' as const,
    sandboxMode: 'readonly' as const,
    maxLoops: 3,
    ...overrides,
  };
}

function createFixtureModel() {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  return faux.getModel();
}

function configureFixtureProvider(
  t: TestContext,
  provider: { apiKey: string; baseUrl: string; model: string },
): void {
  const previous = getConfig();
  t.after(() => setConfig(previous));
  setConfig(ConfigSchema.parse({
    server: {},
    agent: { defaultProvider: 'fixture', defaultModel: provider.model },
    memory: {},
    executor: {},
    auth: {},
    providers: { fixture: { ...provider, enabled: true } },
  }));
}
