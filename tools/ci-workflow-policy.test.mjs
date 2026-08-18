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

  // Both platforms run gate-test / gate-web-e2e without a gate-fast dependency.
  // GitHub: hosted runners are independent; Forgejo (PR #125 / run 421): each
  // job checks out its own tree and the win-los-canary pool sustains concurrent
  // jobs, so wall time is max(job) rather than sum(gate-fast + gate-test).
  assert.equal(github.jobs['gate-test'].needs, undefined);
  assert.equal(github.jobs['gate-web-e2e'].needs, undefined);
  assert.equal(github.jobs['gate-drift'].needs, undefined);
  assert.equal(forgejo.jobs['gate-test'].needs, undefined);
  assert.equal(forgejo.jobs['gate-web-e2e'].needs, undefined);
  assert.equal(forgejo.jobs['gate-drift'].needs, undefined);
});

test('Forgejo gate-fast enables turbo typecheck concurrency', async () => {
  const forgejo = await loadWorkflow('../.forgejo/workflows/ci.yml');
  assert.equal(String(forgejo.jobs['gate-fast'].env?.TURBO_CONCURRENCY ?? ''), '4');
});

const SKIP_IF = "steps.path-gate.outputs.skip_heavy != 'true'";

function laterHeavySteps(job) {
  const idx = job.steps.findIndex((step) => step.id === 'path-gate');
  assert.notEqual(idx, -1, 'job must have id: path-gate');
  return {
    pathGate: job.steps[idx],
    later: job.steps.slice(idx + 1),
  };
}

test('Forgejo heavy jobs skip via path-gate output, not step exit 0', async () => {
  const forgejo = await loadWorkflow('../.forgejo/workflows/ci.yml');

  for (const name of ['gate-test', 'gate-web-e2e']) {
    const { pathGate, later } = laterHeavySteps(forgejo.jobs[name]);
    const script = String(pathGate.run);
    assert.match(script, /tools\/path-gate\.mjs/, `${name} must call the shared classifier`);
    assert.doesNotMatch(script, /grep\s+-qvE/, `${name} must not inline a skip regex`);
    assert.doesNotMatch(script, /exit 0/, `${name} must not use exit 0 as skip`);

    const guarded = later.filter((step) => step.if !== 'always()' && step.if !== 'failure()');
    assert.ok(guarded.length > 0, `${name} must have install/test steps after path-gate`);
    for (const step of guarded) {
      assert.equal(
        step.if,
        SKIP_IF,
        `${name} step "${step.name}" must be gated by skip_heavy`,
      );
    }
  }
});
