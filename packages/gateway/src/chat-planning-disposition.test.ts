import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareChatPlanningDisposition } from './chat-planning-disposition.js';

test('bound created Work Item starts a planning disposition', () => {
  const prepared = prepareChatPlanningDisposition({
    boundTodoId: 'work-1',
    runContract: {
      mode: 'execution',
      executionMode: 'standard',
      phase: 'created',
      goal: 'Implement a bounded change',
      requiredChecks: ['pnpm check'],
    },
  });

  assert.equal(prepared.disposition, 'planning');
  assert.equal(prepared.runContract?.phase, 'planning');
  assert.equal(prepared.runContract?.previousPhase, 'created');
  assert.equal(typeof prepared.runContract?.phaseChangedAt, 'string');
});

test('ordinary chat remains an execution disposition', () => {
  const prepared = prepareChatPlanningDisposition({
    runContract: { mode: 'execution', phase: 'created' },
  });
  assert.equal(prepared.disposition, 'execution');
  assert.equal(prepared.runContract?.phase, 'created');
});
