import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { appendSessionEvent } from './session-events.js';
import {
  createPreActionFailureEvidence,
  loadPreActionEvidence,
  _projectPreActionEvidence,
} from './pre-action-evidence.js';

test('projects persisted failure evidence across sessions in the same project', async () => {
  const suffix = randomUUID();
  const projectId = `pre-action-project-${suffix}`;
  const failedSessionId = `pre-action-failed-${suffix}`;
  const nextSessionId = `pre-action-next-${suffix}`;
  const args = { file_path: `src/fragile-${suffix}.ts` };
  const failure = createPreActionFailureEvidence('write', args, 'typecheck failed', 'call-1');

  await appendSessionEvent({
    sessionId: failedSessionId,
    projectId,
    type: 'tool.pre_action.failure',
    toolName: 'write',
    payload: { ...failure },
  });

  const evidence = await loadPreActionEvidence({ sessionId: nextSessionId, projectId });
  assert.equal(evidence.failureFingerprints?.has(failure.fingerprint), true);
  assert.equal(evidence.fragileFiles?.has(args.file_path), true);

  const unrelated = await loadPreActionEvidence({
    sessionId: `unrelated-${suffix}`,
    projectId: `unrelated-project-${suffix}`,
  });
  assert.equal(unrelated.failureFingerprints?.has(failure.fingerprint), false);
});

test('normalizes legacy feedback fingerprints and applies operator removals', () => {
  const evidence = _projectPreActionEvidence([
    {
      type: 'tool.gate.feedback.fail',
      toolName: 'replace',
      payload: { args: { path: 'src/legacy.ts' } },
    },
    {
      type: 'tool.pre_action.fragile_file.added',
      payload: { path: 'src/operator.ts' },
    },
    {
      type: 'tool.pre_action.fragile_file.removed',
      payload: { path: 'src/operator.ts' },
    },
  ]);

  assert.equal(evidence.failureFingerprints?.has('replace::src/legacy.ts'), true);
  assert.equal(evidence.fragileFiles?.has('src/legacy.ts'), true);
  assert.equal(evidence.fragileFiles?.has('src/operator.ts'), false);
});
