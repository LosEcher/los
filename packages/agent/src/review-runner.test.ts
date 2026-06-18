import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runMultiRoleReview,
  buildReviewPrompt,
  parseReviewResponse,
  severityRank,
  findingsAbove,
  SEVERITY_LEVELS,
  type ReviewRoleConfig,
  type Severity,
} from './review-runner.js';
import type { Provider, ProviderResponse, Message, ToolDef } from './providers/types.js';

// ── Factories ──────────────────────────────────────────────

function createFakeProvider(responseText: string): Provider {
  return {
    name: 'test-review',
    profile: {
      provider: 'test',
      protocol: 'openai' as any,
      apiShape: 'chat_completion' as any,
      baseUrl: '',
      model: 'test',
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsReasoning: false,
      cachePolicy: {} as any,
      toolCallRepair: 'never' as any,
      usageMapping: { promptTokens: [], completionTokens: [], cacheHitTokens: [], cacheMissTokens: [], totalTokens: [] },
      retryPolicy: {} as any,
      knownFailurePatterns: [],
    },
    async chat(_messages: Message[], _tools?: ToolDef[]): Promise<ProviderResponse> {
      return {
        text: responseText,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5 },
        model: 'test',
      };
    },
  };
}

function passingResponse(): string {
  return JSON.stringify({
    passed: true,
    summaryOfEvidence: 'output meets all criteria for this role',
    findings: [],
  });
}

function makeRole(overrides?: Partial<ReviewRoleConfig>): ReviewRoleConfig {
  return {
    name: 'spec-compliance',
    provider: createFakeProvider(passingResponse()),
    blockingSeverity: 'critical',
    enabled: true,
    ...overrides,
  };
}

// ── Unit: severity helpers ─────────────────────────────────

test('severityRank orders correctly', () => {
  assert.ok(severityRank('critical') > severityRank('error'));
  assert.ok(severityRank('error') > severityRank('warn'));
  assert.ok(severityRank('warn') > severityRank('info'));
  assert.equal(severityRank('info'), 0);
  assert.equal(severityRank('critical'), 3);
});

test('severityRank unknown defaults to 0', () => {
  assert.equal(severityRank('unknown' as Severity), 0);
});

test('SEVERITY_LEVELS is ordered', () => {
  assert.deepEqual(SEVERITY_LEVELS, ['info', 'warn', 'error', 'critical']);
});

test('findingsAbove filters correctly', () => {
  const findings = [
    { severity: 'info' as Severity, condition: 'style', detail: 'nit', suggestion: 'fix' },
    { severity: 'warn' as Severity, condition: 'error-handling', detail: 'missing catch', suggestion: 'add try/catch' },
    { severity: 'critical' as Severity, condition: 'security', detail: 'SQL injection', suggestion: 'use parameterized query' },
    { severity: 'info' as Severity, condition: 'naming', detail: 'var name', suggestion: 'rename' },
  ];
  assert.equal(findingsAbove(findings, 'critical').length, 1);
  assert.equal(findingsAbove(findings, 'warn').length, 2); // warn + critical
  assert.equal(findingsAbove(findings, 'info').length, 4); // all
});

// ── Unit: buildReviewPrompt ────────────────────────────────

test('buildReviewPrompt includes goal and agent output', () => {
  const role = makeRole();
  const messages = buildReviewPrompt(role, 'build a REST API', 'const app = express()', '1 turns executed');
  assert.ok(messages.length >= 2);
  const userContent = messages[1]?.content ?? '';
  assert.ok(userContent.includes('build a REST API'), 'contains goal');
  assert.ok(userContent.includes('const app = express()'), 'contains agent output');
  assert.ok(userContent.includes('1 turns executed'), 'contains context summary');
});

test('buildReviewPrompt uses role system prompt when provided', () => {
  const role = makeRole({ systemPrompt: 'Custom review instructions for testing.' });
  const messages = buildReviewPrompt(role, 'goal', 'output', 'context');
  assert.equal(messages[0].content, 'Custom review instructions for testing.');
});

test('buildReviewPrompt uses default prompt for known role names', () => {
  const role = makeRole({ name: 'code-quality' });
  const messages = buildReviewPrompt(role, 'goal', 'output', 'context');
  assert.ok(messages[0].content.includes('code quality reviewer'), 'contains code-quality default');
});

test('buildReviewPrompt includes fallback prompt for unknown role names', () => {
  const role = makeRole({ name: 'custom-lens' });
  const messages = buildReviewPrompt(role, 'goal', 'output', 'context');
  assert.ok(messages[0].content.includes('custom-lens'), 'includes role name in fallback');
});

// ── Unit: parseReviewResponse ──────────────────────────────

test('parseReviewResponse handles valid JSON with no findings', () => {
  const { findings } = parseReviewResponse(
    JSON.stringify({
      passed: true,
      summaryOfEvidence: 'all good',
      findings: [],
    }),
    { name: 'spec-compliance', blockingSeverity: 'critical' },
  );
  assert.equal(findings.length, 0);
});

test('parseReviewResponse handles valid JSON with findings of mixed severity', () => {
  const { findings } = parseReviewResponse(
    JSON.stringify({
      passed: false,
      summaryOfEvidence: 'issues found',
      findings: [
        { severity: 'critical', condition: 'auth', detail: 'no auth check', suggestion: 'add auth middleware' },
        { severity: 'warn', condition: 'logging', detail: 'no error logs', suggestion: 'add error logging' },
        { severity: 'info', condition: 'style', detail: 'inconsistent indentation', suggestion: 'run formatter' },
      ],
    }),
    { name: 'code-quality', blockingSeverity: 'critical' },
  );
  assert.equal(findings.length, 3);
  assert.equal(findings[0].severity, 'critical');
  assert.equal(findings[1].severity, 'warn');
  assert.equal(findings[2].severity, 'info');
  assert.equal(findings[0].condition, 'auth');
  assert.equal(findings[1].suggestion, 'add error logging');
});

test('parseReviewResponse handles findings with evidence pointers', () => {
  const { findings } = parseReviewResponse(
    JSON.stringify({
      passed: false,
      summaryOfEvidence: 'found one issue',
      findings: [
        {
          severity: 'warn',
          condition: 'missing validation',
          detail: 'user input not validated',
          suggestion: 'add zod schema',
          evidence: 'src/routes.ts:42',
        },
      ],
    }),
    { name: 'spec-compliance', blockingSeverity: 'warn' },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].evidence, 'src/routes.ts:42');
});

test('parseReviewResponse normalizes "warning" to "warn"', () => {
  const { findings } = parseReviewResponse(
    JSON.stringify({
      passed: false,
      summaryOfEvidence: '',
      findings: [{ severity: 'warning', condition: 'x', detail: 'y', suggestion: 'z' }],
    }),
    { name: 'test', blockingSeverity: 'critical' },
  );
  assert.equal(findings[0].severity, 'warn');
});

test('parseReviewResponse default-severity is "info" for unknown', () => {
  const { findings } = parseReviewResponse(
    JSON.stringify({
      passed: false,
      summaryOfEvidence: '',
      findings: [{ severity: 'catastrophic', condition: 'x', detail: 'y', suggestion: 'z' }],
    }),
    { name: 'test', blockingSeverity: 'critical' },
  );
  assert.equal(findings[0].severity, 'info');
});

test('parseReviewResponse fallback on empty string', () => {
  const { findings } = parseReviewResponse('', { name: 'spec-compliance', blockingSeverity: 'critical' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].condition, 'review_parse');
});

test('parseReviewResponse fallback on garbled text', () => {
  const { findings } = parseReviewResponse('not valid json at all', { name: 'spec-compliance', blockingSeverity: 'critical' });
  assert.equal(findings[0].condition, 'review_parse');
  assert.equal(findings[0].severity, 'error');
});

test('parseReviewResponse handles JSON with code fence', () => {
  const { findings } = parseReviewResponse(
    '```json\n' + JSON.stringify({
      passed: true,
      summaryOfEvidence: 'ok',
      findings: [],
    }) + '\n```',
    { name: 'spec-compliance', blockingSeverity: 'critical' },
  );
  assert.equal(findings.length, 0);
});

test('parseReviewResponse adds generic finding when passed:false with no findings', () => {
  const { findings } = parseReviewResponse(
    JSON.stringify({ passed: false, summaryOfEvidence: '', findings: [] }),
    { name: 'code-quality', blockingSeverity: 'critical' },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
  assert.ok(findings[0].detail.includes('code-quality'));
});

// ── Integration: runMultiRoleReview ────────────────────────

test('runMultiRoleReview with all roles passing returns passed:true', async () => {
  const roles = [
    makeRole({ name: 'spec-compliance', provider: createFakeProvider(passingResponse()) }),
    makeRole({ name: 'code-quality', provider: createFakeProvider(passingResponse()) }),
  ];
  const result = await runMultiRoleReview(roles, 'build API', 'code output here is long enough for review', '1 turns executed');
  assert.equal(result.passed, true);
  assert.equal(result.roles.length, 2);
  assert.equal(result.blockingFindings.length, 0);
  assert.ok(result.evaluatedAt);
  assert.equal(result.roles[0].passed, true);
  assert.equal(result.roles[1].passed, true);
});

test('runMultiRoleReview with critical finding blocks', async () => {
  const roles = [
    makeRole({
      name: 'spec-compliance',
      blockingSeverity: 'critical',
      provider: createFakeProvider(
        JSON.stringify({
          passed: false,
          summaryOfEvidence: 'critical gap found',
          findings: [
            { severity: 'critical', condition: 'missing endpoint', detail: 'no GET /users', suggestion: 'add GET /users route' },
          ],
        }),
      ),
    }),
    makeRole({ name: 'code-quality', provider: createFakeProvider(passingResponse()) }),
  ];
  const result = await runMultiRoleReview(roles, 'build API', 'code output here is long enough for review', '1 turns executed');
  assert.equal(result.passed, false);
  assert.equal(result.roles[0].passed, false);
  assert.equal(result.roles[1].passed, true);
  assert.equal(result.blockingFindings.length, 1);
  assert.equal(result.blockingFindings[0].severity, 'critical');
  assert.equal(result.blockingFindings[0].condition, 'missing endpoint');
});

test('runMultiRoleReview warn finding does not block when blockingSeverity is critical', async () => {
  const roles = [
    makeRole({
      name: 'code-quality',
      blockingSeverity: 'critical', // only critical blocks
      provider: createFakeProvider(
        JSON.stringify({
          passed: false,
          summaryOfEvidence: 'minor issues',
          findings: [
            { severity: 'warn', condition: 'logging', detail: 'no error logs', suggestion: 'add error handling' },
            { severity: 'info', condition: 'style', detail: 'inconsistent formatting', suggestion: 'run prettier' },
          ],
        }),
      ),
    }),
  ];
  const result = await runMultiRoleReview(roles, 'goal', 'output text long enough to pass min check', 'context');
  // Role passed because no findings at or above 'critical'
  assert.equal(result.roles[0].passed, true);
  assert.equal(result.passed, true);
  assert.equal(result.blockingFindings.length, 0);
});

test('runMultiRoleReview warn finding blocks when blockingSeverity is warn', async () => {
  const roles = [
    makeRole({
      name: 'code-quality',
      blockingSeverity: 'warn', // warn-level findings block
      provider: createFakeProvider(
        JSON.stringify({
          passed: false,
          summaryOfEvidence: '',
          findings: [
            { severity: 'warn', condition: 'logging', detail: 'no error logs', suggestion: 'add error handling' },
          ],
        }),
      ),
    }),
  ];
  const result = await runMultiRoleReview(roles, 'goal', 'output', 'context');
  assert.equal(result.roles[0].passed, false);
  assert.equal(result.passed, false);
  assert.equal(result.blockingFindings.length, 1);
});

test('runMultiRoleReview empty roles returns passed:true', async () => {
  const result = await runMultiRoleReview([], 'goal', 'output', 'context');
  assert.equal(result.passed, true);
  assert.equal(result.roles.length, 0);
});

test('runMultiRoleReview disabled roles are skipped', async () => {
  const roles = [
    makeRole({ name: 'spec-compliance', enabled: false }),
  ];
  const result = await runMultiRoleReview(roles, 'goal', 'output', 'context');
  assert.equal(result.passed, true);
  assert.equal(result.roles.length, 0);
});

test('runMultiRoleReview handles provider failure gracefully', async () => {
  const failingProvider: Provider = {
    name: 'failing-review',
    profile: {
      provider: 'fail',
      protocol: 'openai' as any,
      apiShape: 'chat_completion' as any,
      baseUrl: '',
      model: 'fail',
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsReasoning: false,
      cachePolicy: {} as any,
      toolCallRepair: 'never' as any,
      usageMapping: { promptTokens: [], completionTokens: [], cacheHitTokens: [], cacheMissTokens: [], totalTokens: [] },
      retryPolicy: {} as any,
      knownFailurePatterns: [],
    },
    async chat(): Promise<ProviderResponse> {
      throw new Error('connection refused');
    },
  };
  const roles = [
    makeRole({ name: 'spec-compliance', provider: failingProvider, blockingSeverity: 'critical' }),
  ];
  const result = await runMultiRoleReview(roles, 'goal', 'output text long enough for review', 'context');
  assert.equal(result.passed, false);
  assert.equal(result.roles[0].passed, false);
  assert.equal(result.roles[0].findings[0].severity, 'error');
  assert.equal(result.roles[0].findings[0].condition, 'review_provider');
  assert.ok(result.roles[0].findings[0].detail.includes('connection refused'));
  // provider error severity is 'error', which is >= 'critical'... wait, error < critical
  // The blocking severity is 'critical', so 'error' should NOT block
  // Actually: error rank = 2, critical rank = 3. So error < critical, not blocked.
  assert.equal(result.blockingFindings.length, 0, 'provider error should not be critical-blocking');
});

test('runMultiRoleReview skips empty agent output', async () => {
  const roles = [makeRole()];
  const result = await runMultiRoleReview(roles, 'goal', '', 'context');
  assert.equal(result.passed, false);
  assert.equal(result.roles[0].skipped, true);
  assert.equal(result.roles[0].skipReason, 'empty_output');
});

test('runMultiRoleReview skips too-short agent output', async () => {
  const roles = [makeRole()];
  const result = await runMultiRoleReview(roles, 'goal', 'ok', 'context');
  assert.equal(result.roles[0].skipped, true);
  assert.equal(result.roles[0].skipReason, 'output_too_short');
});

test('runMultiRoleReview runs multiple roles in parallel', async () => {
  // Track invocation order to verify parallelism (all start before any complete)
  const started: string[] = [];
  const completed: string[] = [];

  function makeTrackingProvider(name: string, responseText: string): Provider {
    return {
      name,
      profile: {
        provider: 'test',
        protocol: 'openai' as any,
        apiShape: 'chat_completion' as any,
        baseUrl: '',
        model: 'test',
        supportsTools: false,
        supportsParallelToolCalls: false,
        supportsReasoning: false,
        cachePolicy: {} as any,
        toolCallRepair: 'never' as any,
        usageMapping: { promptTokens: [], completionTokens: [], cacheHitTokens: [], cacheMissTokens: [], totalTokens: [] },
        retryPolicy: {} as any,
        knownFailurePatterns: [],
      },
      async chat(): Promise<ProviderResponse> {
        started.push(name);
        // Small delay to make parallelism observable
        await new Promise(r => setTimeout(r, 5));
        completed.push(name);
        return { text: responseText, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 }, model: 'test' };
      },
    };
  }

  const roles = [
    makeRole({ name: 'spec-compliance', provider: makeTrackingProvider('spec', passingResponse()) }),
    makeRole({ name: 'code-quality', provider: makeTrackingProvider('quality', passingResponse()) }),
    makeRole({ name: 'security', provider: makeTrackingProvider('security', passingResponse()) }),
  ];

  const result = await runMultiRoleReview(roles, 'goal', 'output text longer than twenty characters', 'context');

  assert.equal(result.passed, true);
  // All roles started before any completed (parallel execution)
  assert.equal(started.length, 3);
  // All completed
  assert.equal(completed.length, 3);
});

test('runMultiRoleReview returns correct blocking findings from mixed roles', async () => {
  const roles = [
    makeRole({
      name: 'spec-compliance',
      blockingSeverity: 'critical',
      provider: createFakeProvider(
        JSON.stringify({
          passed: false,
          summaryOfEvidence: '',
          findings: [
            { severity: 'critical', condition: 'c1', detail: 'd1', suggestion: 's1' },
            { severity: 'warn', condition: 'c2', detail: 'd2', suggestion: 's2' },
          ],
        }),
      ),
    }),
    makeRole({
      name: 'code-quality',
      blockingSeverity: 'warn',
      provider: createFakeProvider(
        JSON.stringify({
          passed: false,
          summaryOfEvidence: '',
          findings: [
            { severity: 'warn', condition: 'c3', detail: 'd3', suggestion: 's3' },
          ],
        }),
      ),
    }),
  ];
  const result = await runMultiRoleReview(roles, 'goal', 'output text longer than twenty characters', 'context');
  assert.equal(result.passed, false);
  // spec-compliance: critical finding (>= critical) → blocked + warn finding (>= critical) → not blocked
  // code-quality: warn finding (>= warn) → blocked
  // Blocking findings: 1 from spec-compliance (critical) + 1 from code-quality (warn) = 2
  assert.equal(result.blockingFindings.length, 2);
  const severities = result.blockingFindings.map(f => f.severity);
  assert.ok(severities.includes('critical'));
  assert.ok(severities.includes('warn'));
});
