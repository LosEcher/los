import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { estimateCost } from './model-profiles.js';
import { createProvider } from './providers/index.js';
import type { Message, Provider } from './providers/index.js';
import { createRunSpec, loadRunSpec } from './run-specs.js';
import {
  getDailyAgentScenarioCorpus,
  recordDailyAgentScenarioEconomics,
  summarizeDailyAgentScenarioEconomics,
} from './scenario-economics.js';
import { DAILY_AGENT_SCENARIO_FIXTURES, type DailyAgentScenarioFixture } from './scenario-economics-fixtures.js';
import type {
  DailyAgentScenarioHardAssertion,
  DailyAgentScenarioLane,
  DailyAgentScenarioRole,
} from './scenario-economics-types.js';

const ROLES: DailyAgentScenarioRole[] = ['planner', 'worker', 'reviewer'];
const SYSTEM_PROMPT = [
  'You are evaluating a synthetic LOS daily-agent workflow fixture.',
  'Use only the supplied fixture and prior bounded role artifacts.',
  'Return exactly one JSON object that validates against requiredOutputSchema.',
  'JSON Schema descriptors are constraints, not output values.',
  'Do not add markdown fences, prose, credentials, tool calls, or fields outside the shape.',
].join(' ');

interface RunnerOptions {
  execute: boolean;
  runsPerLane: number;
  runSpecId: string;
  scenarioIds: string[];
  lanes: DailyAgentScenarioLane[];
  candidateProvider?: string;
  candidateModel: string;
}

interface RoleCallResult {
  artifact?: Record<string, unknown>;
  provider: string;
  model: string;
  latencyMs: number;
  retryCount: number;
  promptTokens: number;
  completionTokens: number;
  modelCost: number;
}

type RoleArtifacts = Partial<Record<DailyAgentScenarioRole, Record<string, unknown>>>;

export function _parseRunnerArgs(argv: string[], defaultRunSpecId = defaultCollectionId()): RunnerOptions {
  const execute = argv.includes('--execute');
  const runsPerLane = integerArg(argv, '--runs-per-lane', 1, 1, 20);
  const scenarioIds = repeatedArg(argv, '--scenario');
  const laneArgs = repeatedArg(argv, '--lane');
  const lanes = laneArgs.length === 0
    ? ['baseline', 'candidate'] as DailyAgentScenarioLane[]
    : laneArgs.map(value => expectLane(value));
  return {
    execute,
    runsPerLane,
    runSpecId: stringArg(argv, '--run-spec-id') ?? defaultRunSpecId,
    scenarioIds,
    lanes: [...new Set(lanes)],
    candidateProvider: stringArg(argv, '--candidate-provider'),
    candidateModel: stringArg(argv, '--candidate-model') ?? 'deepseek-v4-pro',
  };
}

export function _buildRolePrompt(
  fixture: DailyAgentScenarioFixture,
  role: DailyAgentScenarioRole,
  priorArtifacts: RoleArtifacts,
): string {
  return JSON.stringify({
    scenario: { id: fixture.id, version: fixture.version, context: fixture.context },
    role,
    priorRoleArtifacts: priorArtifacts,
    requiredOutputSchema: fixture.outputSchemas[role],
  }, null, 2);
}

export function _parseRoleArtifact(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const candidates = [
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
    trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1),
  ];
  for (const candidate of candidates) {
    if (!candidate || !candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* try the next bounded extraction */ }
  }
  return undefined;
}

export function _evaluateScenarioArtifacts(
  fixture: DailyAgentScenarioFixture,
  artifacts: RoleArtifacts,
): DailyAgentScenarioHardAssertion[] {
  return Object.entries(fixture.assertionChecks).map(([id, checks]) => ({
    id,
    passed: checks.every(check => deepEqual(readPath(artifacts[check.role], check.path), check.expected)),
  }));
}

export function _failedChecks(
  fixture: DailyAgentScenarioFixture,
  artifacts: RoleArtifacts,
): Array<{
  assertionId: string;
  role: DailyAgentScenarioRole;
  path: string;
  expected: unknown;
  actual: unknown;
}> {
  return Object.entries(fixture.assertionChecks).flatMap(([assertionId, checks]) => (
    checks.flatMap(check => {
      const actual = readPath(artifacts[check.role], check.path);
      if (deepEqual(actual, check.expected)) return [];
      return [{
        assertionId,
        role: check.role,
        path: check.path,
        expected: check.expected,
        actual: boundedDiagnosticValue(actual),
      }];
    })
  ));
}

export async function _runDailyAgentScenarioCorpus(
  options: RunnerOptions,
  providerFactory: typeof createProvider = createProvider,
): Promise<{ attemptedScenarioRuns: number; failedScenarioRuns: number; report: Awaited<ReturnType<typeof summarizeDailyAgentScenarioEconomics>> }> {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureCollectionRunSpec(options.runSpecId);
  const fixtures = selectFixtures(options.scenarioIds);
  let attemptedScenarioRuns = 0;
  let failedScenarioRuns = 0;

  for (const fixture of fixtures) {
    for (const lane of options.lanes) {
      for (let attempt = 1; attempt <= options.runsPerLane; attempt++) {
        attemptedScenarioRuns++;
        const scenarioRunId = `${options.runSpecId}-${fixture.id}-${lane}-${attempt}`;
        const artifacts: RoleArtifacts = {};
        const roleResults = new Map<DailyAgentScenarioRole, RoleCallResult>();
        for (const role of ROLES) {
          const result = await runRole({ fixture, role, lane, scenarioRunId, options, artifacts, providerFactory });
          if (result.artifact) artifacts[role] = result.artifact;
          roleResults.set(role, result);
          process.stdout.write(`${fixture.id} ${lane} #${attempt} ${role}: ${result.artifact ? 'parsed' : 'failed'}\n`);
        }

        const assertions = _evaluateScenarioArtifacts(fixture, artifacts);
        const passed = assertions.every(assertion => assertion.passed);
        if (!passed) {
          failedScenarioRuns++;
          process.stdout.write(`${JSON.stringify({ failedChecks: _failedChecks(fixture, artifacts) })}\n`);
        }
        for (const role of ROLES) {
          const result = roleResults.get(role)!;
          await recordDailyAgentScenarioEconomics({
            runSpecId: options.runSpecId,
            sessionId: `session-${options.runSpecId}`,
            scenarioId: fixture.id,
            scenarioVersion: fixture.version,
            scenarioRunId,
            lane,
            role,
            requestedProvider: lane === 'candidate' ? options.candidateProvider ?? config.agent.defaultProvider : null,
            requestedModel: lane === 'candidate' ? options.candidateModel : null,
            effectiveProvider: result.provider,
            effectiveModel: result.model,
            routeReason: lane === 'candidate' ? 'explicit_model' : 'configured_default',
            success: result.artifact !== undefined,
            latencyMs: result.latencyMs,
            retryCount: result.retryCount,
            toolErrorCount: 0,
            verificationStatus: role === 'reviewer' ? (passed ? 'succeeded' : 'failed') : 'not_required',
            modelCost: result.modelCost,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            operatorInterventionCount: 0,
            operatorWaitMs: 0,
            planningAttemptCount: role === 'planner' ? 1 : 0,
            executionAttemptCount: role === 'worker' ? 1 : 0,
            revisionCount: fixture.id === 'DA04-revision-recovery' && role === 'planner' ? 1 : 0,
            diffOutcome: role === 'reviewer' ? (passed ? 'accepted' : 'revision_requested') : 'not_reviewed',
            recoveryResult: fixture.id === 'DA05-interrupted-resume' && role === 'reviewer'
              ? (passed ? 'resumed' : 'failed')
              : 'not_required',
            hardAssertions: assertions,
          });
        }
        process.stdout.write(`${fixture.id} ${lane} #${attempt}: ${passed ? 'passed' : 'failed'}\n`);
      }
    }
  }

  await waitForTelemetry();
  const report = await summarizeDailyAgentScenarioEconomics({ runSpecId: options.runSpecId });
  return { attemptedScenarioRuns, failedScenarioRuns, report };
}

async function runRole(input: {
  fixture: DailyAgentScenarioFixture;
  role: DailyAgentScenarioRole;
  lane: DailyAgentScenarioLane;
  scenarioRunId: string;
  options: RunnerOptions;
  artifacts: RoleArtifacts;
  providerFactory: typeof createProvider;
}): Promise<RoleCallResult> {
  const config = await loadConfig();
  const requestedProvider = input.lane === 'candidate'
    ? input.options.candidateProvider ?? config.agent.defaultProvider
    : undefined;
  const requestedModel = input.lane === 'candidate' ? input.options.candidateModel : undefined;
  const provider = input.providerFactory(requestedProvider, { model: requestedModel });
  const totals: RoleCallResult = {
    provider: provider.name,
    model: provider.profile.model,
    latencyMs: 0,
    retryCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    modelCost: 0,
  };
  const userPrompt = _buildRolePrompt(input.fixture, input.role, input.artifacts);

  for (let callAttempt = 1; callAttempt <= 2; callAttempt++) {
    const startedAt = Date.now();
    try {
      const response = await provider.chat(messagesForAttempt(userPrompt, callAttempt), undefined, {
        traceId: `${input.scenarioRunId}:${input.role}:attempt-${callAttempt}`,
        sessionId: `session-${input.options.runSpecId}`,
        modelSettings: { temperature: 0, maxTokens: 700, thinking: 'disabled' },
      });
      addResponseMetrics(totals, provider, response, Date.now() - startedAt);
      const artifact = _parseRoleArtifact(response.text);
      if (artifact && artifact.scenarioId === input.fixture.id && artifact.role === input.role) {
        totals.artifact = artifact;
        return totals;
      }
    } catch {
      totals.latencyMs += Date.now() - startedAt;
    }
    totals.retryCount = callAttempt;
  }
  return totals;
}

function messagesForAttempt(prompt: string, attempt: number): Message[] {
  const correction = attempt === 1 ? '' : '\nThe previous response was invalid. Return only the requested JSON object.';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${prompt}${correction}` },
  ];
}

function addResponseMetrics(
  totals: RoleCallResult,
  provider: Provider,
  response: Awaited<ReturnType<Provider['chat']>>,
  latencyMs: number,
): void {
  totals.latencyMs += latencyMs;
  totals.promptTokens += response.usage.promptTokens;
  totals.completionTokens += response.usage.completionTokens;
  totals.model = response.model || provider.profile.model;
  totals.modelCost += estimateCost(response.usage, provider.profile)?.totalCostUsd ?? 0;
}

async function ensureCollectionRunSpec(runSpecId: string): Promise<void> {
  if (await loadRunSpec(runSpecId)) return;
  await createRunSpec({
    id: runSpecId,
    sessionId: `session-${runSpecId}`,
    tenantId: 'local',
    projectId: 'los',
    userId: 'daily-scenario-runner',
    prompt: 'Collect live provider evidence for the versioned daily-agent scenario corpus.',
    workspaceRoot: process.cwd(),
    toolMode: 'read-only',
  });
}

function selectFixtures(ids: string[]): DailyAgentScenarioFixture[] {
  const corpusIds = new Set(getDailyAgentScenarioCorpus().scenarios.map(scenario => scenario.id));
  const selected = ids.length === 0 ? DAILY_AGENT_SCENARIO_FIXTURES : DAILY_AGENT_SCENARIO_FIXTURES.filter(item => ids.includes(item.id));
  const unknown = ids.filter(id => !corpusIds.has(id));
  if (unknown.length > 0) throw new Error(`unknown scenario: ${unknown.join(', ')}`);
  return selected;
}

function readPath(value: Record<string, unknown> | undefined, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[key]
      : undefined
  ), value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boundedDiagnosticValue(value: unknown): unknown {
  if (value === undefined) return '<missing>';
  const serialized = JSON.stringify(value);
  if (serialized.length <= 160) return value;
  return `${serialized.slice(0, 157)}...`;
}

function repeatedArg(argv: string[], name: string): string[] {
  return argv.flatMap((value, index) => value === name && argv[index + 1] ? [argv[index + 1]!] : []);
}

function stringArg(argv: string[], name: string): string | undefined {
  return repeatedArg(argv, name).at(-1);
}

function integerArg(argv: string[], name: string, fallback: number, min: number, max: number): number {
  const raw = stringArg(argv, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

function expectLane(value: string): DailyAgentScenarioLane {
  if (value === 'baseline' || value === 'candidate') return value;
  throw new Error(`unknown lane: ${value}`);
}

function defaultCollectionId(): string {
  return `daily-scenario-live-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
}

async function waitForTelemetry(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const pending = await getDb().query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM provider_call_telemetry WHERE created_at > now() - interval '1 second'`,
    ).catch(() => ({ rows: [{ count: 0 }] }));
    if (Number(pending.rows[0]?.count ?? 0) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function main(): Promise<void> {
  const options = _parseRunnerArgs(process.argv.slice(2));
  const fixtures = selectFixtures(options.scenarioIds);
  const callCount = fixtures.length * options.lanes.length * options.runsPerLane * ROLES.length;
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({ mode: 'dry-run', runSpecId: options.runSpecId, scenarios: fixtures.map(item => item.id), lanes: options.lanes, runsPerLane: options.runsPerLane, providerCallCount: callCount }, null, 2)}\n`);
    return;
  }
  try {
    const result = await _runDailyAgentScenarioCorpus(options);
    const telemetry = await getDb().query<{ count: number; successful: number }>(
      `SELECT COUNT(*)::integer AS count, COUNT(*) FILTER (WHERE status BETWEEN 200 AND 299)::integer AS successful
       FROM provider_call_telemetry WHERE trace_id LIKE $1`,
      [`${options.runSpecId}%`],
    );
    process.stdout.write(`${JSON.stringify({
      runSpecId: options.runSpecId,
      attemptedScenarioRuns: result.attemptedScenarioRuns,
      failedScenarioRuns: result.failedScenarioRuns,
      providerCalls: telemetry.rows[0],
      evidence: result.report.evidence,
      automaticRouting: result.report.automaticRouting,
      totals: result.report.totals,
      byLane: result.report.byLane,
      byRoute: result.report.byRoute,
    }, null, 2)}\n`);
    const requiresCompleteCorpus = options.scenarioIds.length === 0 && options.lanes.length === 2 && options.runsPerLane >= 3;
    const exitCode = result.failedScenarioRuns > 0
      || (requiresCompleteCorpus && result.report.evidence.status !== 'ready_for_policy_review') ? 1 : 0;
    await closeDb().catch(() => undefined);
    process.exit(exitCode);
  } finally {
    await closeDb().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(async error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
}
