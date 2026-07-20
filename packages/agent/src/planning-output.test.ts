import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlanningPrompt, parsePlanningOutput } from './planning-output.js';

test('parsePlanningOutput accepts a structured executable plan', () => {
  const output = parsePlanningOutput(JSON.stringify({
    summary: 'Update the contract before implementation.',
    plan: [{
      id: 'contract',
      title: 'Update contract',
      description: 'Declare the new request field.',
      dependsOnIds: [],
      editableSurfaces: ['contracts/run-spec.yaml'],
      completionCriteria: 'The generated validator accepts the field.',
    }],
    verifications: [{
      id: 'contracts',
      kind: 'command',
      description: 'Check generated contract drift.',
      command: './tools/check-contracts.sh',
    }],
  }));

  assert.equal(output.plan[0]?.id, 'contract');
  assert.equal(output.verifications[0]?.kind, 'command');
  assert.match(buildPlanningPrompt('Change the API'), /read-only tools/);
});

test('parsePlanningOutput rejects prose and incomplete plan steps', () => {
  assert.throws(() => parsePlanningOutput('First, update the contract.'), /expected JSON object/);
  assert.throws(() => parsePlanningOutput(JSON.stringify({
    plan: [{ id: 'step-1', title: 'Missing fields' }],
  })), /requires a non-empty description/);
});

test('parsePlanningOutput rejects non-command verification kinds', () => {
  assert.throws(() => parsePlanningOutput(JSON.stringify({
    plan: [{
      id: 'step-1',
      title: 'Review',
      description: 'Prepare a review.',
      dependsOnIds: [],
      editableSurfaces: [],
      completionCriteria: 'Review is ready.',
    }],
    verifications: [{
      id: 'review',
      kind: 'operator_review',
      description: 'Operator reviews the output.',
    }],
  })), /unsupported approval kind/);
});
