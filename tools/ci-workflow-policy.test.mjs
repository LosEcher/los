import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

async function loadWorkflow(path) {
  return YAML.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

test('GitHub cancels only superseded runs for the same event and PR or ref', async () => {
  const workflow = await loadWorkflow('../.github/workflows/ci.yml');

  assert.deepEqual(workflow.concurrency, {
    group: 'github-ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}',
    'cancel-in-progress': true,
  });
});

test('heavy-job ordering matches each CI platform capacity policy', async () => {
  const github = await loadWorkflow('../.github/workflows/ci.yml');
  const forgejo = await loadWorkflow('../.forgejo/workflows/ci.yml');

  assert.equal(github.jobs['gate-test'].needs, undefined);
  assert.equal(github.jobs['gate-web-e2e'].needs, undefined);
  assert.equal(forgejo.jobs['gate-test'].needs, 'gate-fast');
  assert.equal(forgejo.jobs['gate-web-e2e'].needs, 'gate-fast');
});
