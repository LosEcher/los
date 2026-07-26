import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigSchema, loadConfig, setConfig } from '@los/infra/config';
import { runAgent } from './loop.js';
import { buildPlanningPrompt, parsePlanningOutput } from './planning-output.js';
import { registerPlanningSubmissionTool } from './planning-submission-tool.js';
import { createToolRegistry } from './tools/core/registry.js';

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
  assert.match(buildPlanningPrompt('Change the API'), /submit_run_contract/);
  assert.doesNotMatch(buildPlanningPrompt('Change the API'), /final response must be one JSON object/);
  assert.match(buildPlanningPrompt('Change the API', 'text_json_legacy'), /final response must be one JSON object/);
  const contractPrompt = buildPlanningPrompt('Change the API', 'typed_tool', {
    goal: 'Only inspect package metadata.',
    toolMode: 'read-only',
    editableSurfaces: ['package.json'],
    requiredChecks: ['node --check package.json'],
    allowedSkippedChecks: [],
    stopConditions: ['Do not read other files.'],
    evidenceRequired: [],
    externalEvidenceAllowed: [],
    rawEvidenceProhibited: [],
  });
  assert.match(contractPrompt, /Only inspect package metadata/);
  assert.match(contractPrompt, /node --check package\.json/);
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

test('submit_run_contract accepts one typed plan and rejects trusted identifiers', async () => {
  const registry = createToolRegistry({
    allowedTools: ['submit_run_contract'],
    policy: { maxRiskLevel: 'L0', allowWrites: false, sandboxAvailable: false },
  });
  const collector = registerPlanningSubmissionTool(registry, {
    runContract: {
      phase: 'planning',
      editableSurfaces: ['package.json'],
      requiredChecks: [],
    },
  });
  const plan = {
    summary: 'One bounded step.',
    plan: [{
      id: 'step-1',
      title: 'Inspect',
      description: 'Inspect the declared surface.',
      dependsOnIds: [],
      editableSurfaces: ['package.json'],
      completionCriteria: 'The package name is reported.',
    }],
    verifications: [],
  };

  const rejected = await registry.execute({
    name: 'submit_run_contract',
    arguments: { ...plan, runSpecId: 'model-controlled' },
  });
  assert.match(rejected.error ?? '', /unexpected fields runSpecId/);
  assert.equal(collector.getSubmission(), undefined);

  const outOfScope = await registry.execute({
    name: 'submit_run_contract',
    arguments: {
      ...plan,
      plan: [{ ...plan.plan[0], editableSurfaces: ['packages/agent/src'] }],
    },
  });
  assert.match(outOfScope.error ?? '', /exceed the RunContract scope/);
  assert.equal(collector.getSubmission(), undefined);

  const accepted = await registry.execute({ name: 'submit_run_contract', arguments: plan });
  assert.equal(accepted.error, undefined);
  assert.equal(collector.getSubmission()?.plan[0]?.id, 'step-1');

  const duplicate = await registry.execute({ name: 'submit_run_contract', arguments: plan });
  assert.match(duplicate.error ?? '', /already accepted/);
});

test('planning loop offers the typed tool and returns its accepted submission', async (t) => {
  await configureFixtureProvider(t);
  const requests: Array<Record<string, any>> = [];
  const plan = {
    summary: 'Inspect one file.',
    plan: [{
      id: 'inspect',
      title: 'Inspect package metadata',
      description: 'Read the package manifest.',
      dependsOnIds: [],
      editableSurfaces: ['package.json'],
      completionCriteria: 'The package name and package manager are reported.',
    }],
    verifications: [],
  };
  let call = 0;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    call += 1;
    return new Response(JSON.stringify(call === 1 ? {
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: 'call-plan',
            type: 'function',
            function: { name: 'submit_run_contract', arguments: JSON.stringify(plan) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      model: 'fixture-model',
    } : {
      choices: [{ message: { content: 'Plan submitted.', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      model: 'fixture-model',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await runAgent(buildPlanningPrompt('Inspect package.json'), {
    provider: 'fixture',
    planningTransport: 'typed_tool',
    toolMode: 'read-only',
    sandboxMode: 'readonly',
    skipPreExecutionPhases: true,
    runContractMetadata: { runContract: { phase: 'planning' } },
    maxLoops: 2,
  });

  assert.equal(result.planningSubmission?.plan[0]?.id, 'inspect');
  assert.equal(result.text, 'Plan submitted.');
  const offered = requests[0]?.tools?.find((tool: any) => tool.function?.name === 'submit_run_contract');
  assert.ok(offered);
  assert.equal(offered.function.parameters.properties.runSpecId, undefined);
});

async function configureFixtureProvider(t: TestContext): Promise<void> {
  const previous = await loadConfig();
  t.after(() => setConfig(previous));
  setConfig(ConfigSchema.parse({
    server: {}, agent: { defaultProvider: 'fixture' }, memory: {}, executor: {}, auth: {},
    providers: {
      fixture: {
        apiKey: 'fixture-key',
        baseUrl: 'https://fixture.invalid/v1',
        model: 'fixture-model',
        enabled: true,
      },
    },
  }));
}
