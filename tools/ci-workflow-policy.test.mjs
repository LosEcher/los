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

test('GitHub gate-test heavy steps skip on mirror/* heads (mirror-PR lane)', async () => {
  // Mirror PRs (head mirror/*, e.g. mirror/forgejo-main-sync) carry Forgejo-
  // validated content; re-running the full test suite on GitHub adds no merge
  // evidence. Heavy steps skip at step level so the required gate-test check
  // stays green. Non-mirror PRs and main pushes keep the full suite.
  //
  // ACCEPTED COST (2026-10-07): this skip means the turbo test path
  // (`pnpm test` -> tools/run-tests.sh -> `turbo test`) is first exercised on
  // the push to main, and Forgejo's direct `pnpm --filter @los/* test` calls
  // cannot detect turbo-path defects. That is exactly how a turbo.json
  // regression (3130de14) kept every PR green while 9 consecutive main pushes
  // failed. The skip stays, but the turbo -> task env contract is now asserted
  // by tools/check-turbo-env-passthrough.mjs in an always-on gate phase.
  const github = await loadWorkflow('../.github/workflows/ci.yml');
  const mirrorSkip = "${{ !startsWith(github.head_ref, 'mirror/') }}";

  const heavy = github.jobs['gate-test'].steps.filter((step) =>
    step.name === 'Test root workspace' || step.name === 'Enforce critical module coverage',
  );
  assert.equal(heavy.length, 2, 'gate-test must still declare both heavy steps');
  for (const step of heavy) {
    assert.equal(
      step.if,
      mirrorSkip,
      `gate-test step "${step.name}" must skip on mirror/* heads`,
    );
  }

  // Resource observation is diagnostics only; skip it too so mirror runs do
  // not wait on a file the skipped test step never wrote.
  const observation = github.jobs['gate-test'].steps.find((step) =>
    step.name === 'Report test resource observation',
  );
  assert.ok(observation, 'gate-test must keep the resource observation step');
  assert.equal(
    observation.if,
    "${{ always() && !startsWith(github.head_ref, 'mirror/') }}",
    'resource observation must still run on non-mirror failures but skip on mirror heads',
  );
});

test('Forgejo installs are bounded and preceded by the registry egress preflight', async () => {
  const forgejo = await loadWorkflow('../.forgejo/workflows/ci.yml');

  for (const [jobName, job] of Object.entries(forgejo.jobs)) {
    const installIndex = job.steps.findIndex((step) => step.name === 'Install dependencies');
    if (installIndex === -1) continue;

    const install = job.steps[installIndex];
    assert.equal(install['timeout-minutes'], 8, `${jobName} install must be bounded to 8m`);

    const preflight = job.steps[installIndex - 1];
    assert.equal(
      preflight?.name,
      'CI egress preflight (registry)',
      `${jobName} install must be preceded by the egress preflight`,
    );
    assert.equal(preflight['timeout-minutes'], 1, `${jobName} preflight must be bounded to 1m`);
    assert.match(String(preflight.run), /curl .*registry\.npmjs\.org/, `${jobName} preflight must probe the registry`);

    if (jobName === 'gate-test' || jobName === 'gate-web-e2e') {
      assert.equal(preflight.if, SKIP_IF, `${jobName} preflight must follow the path gate`);
    } else {
      assert.equal(preflight.if, undefined, `${jobName} preflight must always run`);
    }
  }
});

test('Forgejo gate-test runs packages concurrently with the agent groups', async () => {
  const forgejo = await loadWorkflow('../.forgejo/workflows/ci.yml');
  const steps = forgejo.jobs['gate-test'].steps;

  assert.equal(
    steps.some((step) => step.name === 'Test other packages'),
    false,
    'packages must not be a separate sequential gate-test step',
  );

  const agent = steps.find((step) => step.id === 'test-agent');
  assert.ok(agent, 'gate-test must keep the test-agent step');
  const run = String(agent.run);
  assert.match(run, /LOS_TEST_GROUP=3/, 'agent group 3 must still run');
  assert.match(run, /--filter '@los\/\*' --filter '!@los\/agent' test/, 'packages suite must run in the same step');
  assert.match(run, /PID4=\$\!/, 'packages must be a fourth background pipeline');
  assert.match(run, /\[ \$S1 -eq 0 \] && \[ \$S2 -eq 0 \] && \[ \$S3 -eq 0 \] && \[ \$S4 -eq 0 \]/, 'all four exit statuses must be required');
});
