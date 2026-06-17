import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createServer } from './server.js';

const BASE_TIME = '2026-06-05T12:00:00.000Z';

test('external summary routes import bounded redacted summaries', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  // Include auth token when auth is enabled (matches .env LOS_AUTH_ENABLED + LOS_AUTH_TOKEN)
  const authHeaders: Record<string, string> = {};
  if (config.auth.enabled && config.auth.token) {
    authHeaders['x-los-auth-token'] = config.auth.token;
  }
  const headers = Object.keys(authHeaders).length > 0 ? authHeaders : undefined;

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const id = `external-summary-route-${suffix}`;
  const app = await createServer({
    serviceId: `external-summary-route-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/external-summaries',
      headers,
      payload: {
        id,
        tool: 'codex',
        source: {
          kind: 'operator_summary',
          sourceRef: `operator-note:${suffix}`,
          cwd: '/repo/projects/los',
        },
        provenance: {
          collectedAt: BASE_TIME,
          capturePolicy: 'bounded-summary-only',
          redactionPolicy: 'no raw prompt/stdout/stderr/auth snapshots',
          importedBy: 'route-test',
        },
        summary: 'Codex imported a bounded summary with fake key sk-test1234567890.',
        findings: ['Do not write this as session_events.'],
        evidence: [
          { label: 'commit', kind: 'commit', value: 'abc123' },
        ],
        labels: ['codex'],
      },
    });
    assert.equal(response.statusCode, 201);
    const imported = response.json().summary;
    assert.equal(imported.id, id);
    assert.equal(imported.evidenceClass, 'external_summary');
    assert.equal(imported.redaction.status, 'redacted');
    assert.match(imported.summary, /\[redacted\]/);

    const raw = await app.inject({
      method: 'POST',
      url: '/external-summaries',
      headers,
      payload: {
        tool: 'codex',
        source: {
          kind: 'operator_summary',
          sourceRef: `operator-note:${suffix}-raw`,
        },
        provenance: {
          collectedAt: BASE_TIME,
          capturePolicy: 'raw',
          redactionPolicy: 'none',
        },
        summary: 'unsafe',
        rawTranscript: 'must not be stored',
      },
    });
    assert.equal(raw.statusCode, 422);
    assert.match(raw.json().error, /rejects raw field/);

    const listed = await app.inject({
      method: 'GET',
      url: '/external-summaries?tool=codex',
      headers,
    });
    assert.equal(listed.statusCode, 200);
    const body = listed.json();
    assert.ok(body.summaries.some((item: { id: string }) => item.id === id));
  } finally {
    await getDb().query('DELETE FROM external_tool_summaries WHERE id = $1', [id]).catch(() => undefined);
    await app.close();
    await closeDb().catch(() => undefined);
  }
});
