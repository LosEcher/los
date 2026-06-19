import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  addObservation,
  ensureMemoryStore,
} from './core/store.js';
import {
  compactSession,
  ensureMemoryCompactionStore,
  promoteCandidate,
} from './core/compaction.js';
import {
  retrieveActiveRules,
  formatRulesForPrompt,
  resolveMemoryLayers,
  routeMemoryRetrieval,
  augmentSystemPrompt,
} from './core/retrieval.js';

// ── resolveMemoryLayers ──────────────────────────────────

test('resolveMemoryLayers maps created to working + procedural', () => {
  const layers = resolveMemoryLayers('created');
  assert.deepEqual(layers, ['working', 'procedural']);
});

test('resolveMemoryLayers maps running to working + procedural + episodic', () => {
  const layers = resolveMemoryLayers('running');
  assert.deepEqual(layers, ['working', 'procedural', 'episodic']);
});

test('resolveMemoryLayers maps blocked to episodic + procedural + semantic + self_reflective', () => {
  const layers = resolveMemoryLayers('blocked');
  assert.deepEqual(layers, ['episodic', 'procedural', 'semantic', 'self_reflective']);
});

test('resolveMemoryLayers maps failed to episodic + semantic + self_reflective', () => {
  const layers = resolveMemoryLayers('failed');
  assert.deepEqual(layers, ['episodic', 'semantic', 'self_reflective']);
});

test('resolveMemoryLayers maps succeeded to empty array', () => {
  const layers = resolveMemoryLayers('succeeded');
  assert.deepEqual(layers, []);
});

test('resolveMemoryLayers maps undefined to working + procedural', () => {
  const layers = resolveMemoryLayers(undefined);
  assert.deepEqual(layers, ['working', 'procedural']);
});

// ── formatRulesForPrompt ─────────────────────────────────

test('formatRulesForPrompt returns empty string for empty rules', () => {
  const result = formatRulesForPrompt([]);
  assert.equal(result, '');
});

test('formatRulesForPrompt formats rules with severity icons', () => {
  const rules = [
    {
      name: 'test-rule',
      content: 'Always read files before editing.',
      severity: 'warn' as const,
      rationale: 'Prevents stale edits.',
      confidence: 0.85,
      sourceCompactionIds: ['comp-1'],
    },
  ];
  const result = formatRulesForPrompt(rules);
  assert.ok(result.includes('## Active Procedural Rules'));
  assert.ok(result.includes('⚡ test-rule'));
  assert.ok(result.includes('85%'));
  assert.ok(result.includes('Always read files before editing.'));
  assert.ok(result.includes('Prevents stale edits.'));
});

test('formatRulesForPrompt handles multiple rules', () => {
  const rules = [
    {
      name: 'rule-a',
      content: 'Content A.',
      severity: 'info' as const,
      rationale: 'Rationale A.',
      confidence: 0.7,
      sourceCompactionIds: ['comp-1'],
    },
    {
      name: 'rule-b',
      content: 'Content B.',
      severity: 'error' as const,
      rationale: 'Rationale B.',
      confidence: 0.95,
      sourceCompactionIds: ['comp-2'],
    },
  ];
  const result = formatRulesForPrompt(rules);
  assert.ok(result.includes('ℹ️ rule-a'));
  assert.ok(result.includes('⚠️ rule-b'));
  assert.ok(result.includes('Content A.'));
  assert.ok(result.includes('Content B.'));
});

// ── retrieveActiveRules ──────────────────────────────────

test('retrieveActiveRules returns active candidates from compactions', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-retrieval-${suffix}`;
  const compactionId = `memcomp-${sessionId}-test`;

  try {
    await ensureMemoryCompactionStore();

    // Directly insert a compaction with an active procedural candidate
    await getDb().query(
      `INSERT INTO memory_compactions (
         id, session_id, summary_json, observed_patterns_json,
         procedural_candidates_json, confidence, evidence_count
       )
       VALUES ($1, $2, '{}'::jsonb, '[]'::jsonb, $3::jsonb, 85, 3)`,
      [
        compactionId,
        sessionId,
        JSON.stringify([
          {
            name: 'test-active-rule',
            content: 'Always read files before editing.',
            severity: 'warn',
            rationale: 'Prevents editing stale content.',
            confidence: 0.85,
            status: 'active',
            supportingSessionIds: [sessionId],
          },
        ]),
      ],
    );

    const rules = await retrieveActiveRules();
    assert.ok(rules.length > 0, 'should find at least one active rule');
    const rule = rules.find(r => r.name === 'test-active-rule');
    assert.ok(rule, 'should find the inserted rule');
    assert.equal(rule?.content, 'Always read files before editing.');
    assert.equal(rule?.severity, 'warn');
    assert.equal(rule?.confidence, 0.85);
    assert.ok(rule?.sourceCompactionIds.includes(compactionId));
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('retrieveActiveRules deduplicates by name', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionA = `session-dedup-a-${suffix}`;
  const sessionB = `session-dedup-b-${suffix}`;

  try {
    await ensureMemoryCompactionStore();

    // Insert two compactions with the same candidate name, both active
    await getDb().query(
      `INSERT INTO memory_compactions (
         id, session_id, summary_json, observed_patterns_json,
         procedural_candidates_json, confidence, evidence_count
       )
       VALUES ($1, $2, '{}'::jsonb, '[]'::jsonb, $3::jsonb, 70, 2)`,
      [
        `memcomp-${sessionA}`,
        sessionA,
        JSON.stringify([
          {
            name: 'shared-rule-name',
            content: 'Content from session A.',
            severity: 'info',
            rationale: 'Rationale A.',
            confidence: 0.7,
            status: 'active',
            supportingSessionIds: [sessionA],
          },
        ]),
      ],
    );
    await getDb().query(
      `INSERT INTO memory_compactions (
         id, session_id, summary_json, observed_patterns_json,
         procedural_candidates_json, confidence, evidence_count
       )
       VALUES ($1, $2, '{}'::jsonb, '[]'::jsonb, $3::jsonb, 90, 3)`,
      [
        `memcomp-${sessionB}`,
        sessionB,
        JSON.stringify([
          {
            name: 'shared-rule-name',
            content: 'Content from session B.',
            severity: 'warn',
            rationale: 'Rationale B.',
            confidence: 0.9,
            status: 'active',
            supportingSessionIds: [sessionB],
          },
        ]),
      ],
    );

    const rules = await retrieveActiveRules();
    const matching = rules.filter(r => r.name === 'shared-rule-name');
    assert.equal(matching.length, 1, 'should deduplicate by name');
    if (matching.length > 0) {
      assert.equal(matching[0]!.sourceCompactionIds.length, 2, 'should merge source compaction IDs');
      // Should keep the higher confidence (0.9 from session B)
      assert.equal(matching[0]!.confidence, 0.9, 'should keep higher confidence');
    }
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id IN ($1, $2)', [sessionA, sessionB]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('retrieveActiveRules keeps project-scoped candidates isolated', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionA = `session-scope-a-${suffix}`;
  const sessionB = `session-scope-b-${suffix}`;
  const sessionGlobal = `session-scope-global-${suffix}`;

  try {
    await ensureMemoryCompactionStore();

    for (const item of [
      { id: `memcomp-${sessionA}`, sessionId: sessionA, tenantId: 'tenant-a', projectId: 'project-a', name: 'project-a-rule' },
      { id: `memcomp-${sessionB}`, sessionId: sessionB, tenantId: 'tenant-a', projectId: 'project-b', name: 'project-b-rule' },
      { id: `memcomp-${sessionGlobal}`, sessionId: sessionGlobal, tenantId: null, projectId: null, name: 'global-rule' },
    ]) {
      await getDb().query(
        `INSERT INTO memory_compactions (
           id, session_id, tenant_id, project_id, summary_json, observed_patterns_json,
           procedural_candidates_json, confidence, evidence_count
         )
         VALUES ($1, $2, $3, $4, '{}'::jsonb, '[]'::jsonb, $5::jsonb, 90, 3)`,
        [
          item.id,
          item.sessionId,
          item.tenantId,
          item.projectId,
          JSON.stringify([
            {
              name: item.name,
              content: `Content for ${item.name}.`,
              severity: 'info',
              rationale: 'scope test',
              confidence: 0.9,
              status: 'active',
              supportingSessionIds: [item.sessionId],
            },
          ]),
        ],
      );
    }

    const rules = await retrieveActiveRules({ tenantId: 'tenant-a', projectId: 'project-a' });
    const names = rules.map(r => r.name);
    assert.ok(names.includes('project-a-rule'));
    assert.ok(names.includes('global-rule'));
    assert.equal(names.includes('project-b-rule'), false);
  } finally {
    await getDb().query(
      'DELETE FROM memory_compactions WHERE session_id IN ($1, $2, $3)',
      [sessionA, sessionB, sessionGlobal],
    ).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

// ── routeMemoryRetrieval ─────────────────────────────────

test('routeMemoryRetrieval returns observations by layer for running state', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-route-${suffix}`;

  try {
    await ensureMemoryStore();

    // Add observations at different memory layers
    await addObservation({
      title: 'working memory observation',
      kind: 'note',
      sessionId,
      metadata: { memoryLayer: 'working' },
    });
    await addObservation({
      title: 'episodic memory observation',
      kind: 'note',
      sessionId,
      metadata: { memoryLayer: 'episodic' },
    });

    const result = await routeMemoryRetrieval({
      taskState: 'running',
      sessionId,
    });

    assert.deepEqual(result.queriedLayers, ['working', 'procedural', 'episodic']);
    assert.ok(result.observationsByLayer.working.length > 0, 'should find working memory');
    assert.ok(result.observationsByLayer.episodic.length > 0, 'should find episodic memory');
    // procedural layer comes from compactions, not observations — may be empty
    assert.equal(result.observationsByLayer.semantic.length, 0, 'semantic not queried for running');
  } finally {
    await closeDb().catch(() => undefined);
  }
});

// ── augmentSystemPrompt ──────────────────────────────────

test('augmentSystemPrompt returns base prompt unchanged when no rules or observations', () => {
  const base = 'You are a helpful assistant.';
  const result = augmentSystemPrompt(base, {
    activeRules: [],
    observationsByLayer: { working: [], episodic: [], semantic: [], procedural: [], self_reflective: [] },
    queriedLayers: [],
  });
  assert.equal(result.augmentedPrompt, base);
});

test('augmentSystemPrompt appends active rules section', () => {
  const base = 'You are a helpful assistant.';
  const result = augmentSystemPrompt(base, {
    activeRules: [
      {
        name: 'test-rule',
        content: 'Always verify before writing.',
        severity: 'warn',
        rationale: 'Safety first.',
        confidence: 0.9,
        sourceCompactionIds: ['comp-1'],
      },
    ],
    observationsByLayer: { working: [], episodic: [], semantic: [], procedural: [], self_reflective: [] },
    queriedLayers: ['procedural'],
  });
  assert.ok(result.augmentedPrompt.startsWith(base));
  assert.ok(result.augmentedPrompt.includes('## Active Procedural Rules'));
  assert.ok(result.augmentedPrompt.includes('Always verify before writing.'));
});

test('augmentSystemPrompt appends observation layers when present', () => {
  const base = 'You are a helpful assistant.';
  const result = augmentSystemPrompt(base, {
    activeRules: [],
    observationsByLayer: {
      working: [{ id: 1, title: 'Current task context', summary: 'Working on feature X', kind: 'note', tags: [], content: '', metadata: {}, source: 'agent', createdAt: '', updatedAt: '' }],
      episodic: [],
      semantic: [],
      procedural: [],
      self_reflective: [],
    },
    queriedLayers: ['working'],
  });
  assert.ok(result.augmentedPrompt.includes('## Working Memory'));
  assert.ok(result.augmentedPrompt.includes('Current task context'));
});
