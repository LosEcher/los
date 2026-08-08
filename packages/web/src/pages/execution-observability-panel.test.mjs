import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

describe('execution observability panel wiring', () => {
  it('defines projection helpers and panel surface', () => {
    const panel = read('pages/execution-observability-panel.tsx');
    assert.match(panel, /execution-observability/);
    assert.match(panel, /export function ExecutionObservabilityPanel/);
    assert.match(panel, /export function summarizeWaterfall/);
    assert.match(panel, /export function formatDurationMs/);
    assert.match(panel, /failureFacets/);
    assert.match(panel, /fingerprint/);
    assert.match(panel, /waterfall/);
  });

  it('is mounted on Sessions and Chat inspectors', () => {
    const sessions = read('pages/sessions-page.tsx');
    const chat = read('chat-page.tsx');
    assert.match(sessions, /ExecutionObservabilityPanel/);
    assert.match(chat, /ExecutionObservabilityPanel/);
    assert.match(chat, /compact/);
  });

  it('invalidates projection after chat stream/run completion', () => {
    const run = read('hooks/useChatRun.ts');
    assert.match(run, /session-execution-observability/);
  });

  it('exposes typed projection contract on the web API layer', () => {
    const types = read('api/types-sessions.ts');
    assert.match(types, /export type ExecutionObservabilityProjection/);
    assert.match(types, /ExecutionFailureFacet/);
    assert.match(types, /ExecutionTurnWaterfall/);
  });
});
