import assert from 'node:assert/strict';
import test from 'node:test';

import { validateScheduledExecutionRunTemplate } from './policy.js';
import type { ScheduledWorkRunTemplate } from './types.js';

const remoteExecutionTemplate: ScheduledWorkRunTemplate = {
  templateId: 'scheduled_execution',
  mode: 'execution',
  goalTemplate: 'run the diagnosis',
  editableSurfaces: ['/opt/los/los-workspace'],
  requiredChecks: ['report the result'],
  toolMode: 'all',
  sandboxMode: 'sandbox',
  workspaceRoot: '/opt/los/los-workspace',
  executor: { nodeId: 'node34-executor-1', enabled: true },
};

test('validateScheduledExecutionRunTemplate accepts a fully-specified remote-execution template', () => {
  assert.doesNotThrow(() => validateScheduledExecutionRunTemplate(remoteExecutionTemplate));
});

test('remote executor without sandboxMode is rejected (silent L1 cap trap)', () => {
  const { sandboxMode, ...withoutSandbox } = remoteExecutionTemplate;
  assert.throws(() => validateScheduledExecutionRunTemplate(withoutSandbox), /requires sandboxMode/);
});

test('remote executor without workspaceRoot is rejected (gateway-root trap)', () => {
  const { workspaceRoot, ...withoutRoot } = remoteExecutionTemplate;
  assert.throws(() => validateScheduledExecutionRunTemplate(withoutRoot), /requires workspaceRoot/);
});

test('a disabled executor does not force sandboxMode/workspaceRoot', () => {
  assert.doesNotThrow(() => validateScheduledExecutionRunTemplate({
    ...remoteExecutionTemplate,
    sandboxMode: undefined,
    workspaceRoot: undefined,
    executor: { nodeId: 'node34-executor-1', enabled: false },
  }));
});

test('a local (executor-less) execution template does not require the remote fields', () => {
  const { executor, ...local } = remoteExecutionTemplate;
  assert.doesNotThrow(() => validateScheduledExecutionRunTemplate(local));
});

test('maxLoops bounds are enforced', () => {
  assert.throws(() => validateScheduledExecutionRunTemplate({ ...remoteExecutionTemplate, maxLoops: 0 }), /maxLoops/);
  assert.throws(() => validateScheduledExecutionRunTemplate({ ...remoteExecutionTemplate, maxLoops: 201 }), /maxLoops/);
  assert.doesNotThrow(() => validateScheduledExecutionRunTemplate({ ...remoteExecutionTemplate, maxLoops: 200 }));
});

test('toolMode must be project-write or all for execution', () => {
  assert.throws(
    () => validateScheduledExecutionRunTemplate({ ...remoteExecutionTemplate, toolMode: 'read-only' }),
    /tool mode/,
  );
});
