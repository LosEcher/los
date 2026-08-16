import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

describe('timeline + topology panel wiring', () => {
  it('defines timeline gantt projection with status mapping', () => {
    const gantt = read('pages/timeline-gantt.tsx');
    assert.match(gantt, /export function projectGanttBars/);
    assert.match(gantt, /export function TimelineGantt/);
    assert.match(gantt, /tool-denied/);
    assert.match(gantt, /tool-error/);
    assert.match(gantt, /durationMs/);
    // Only timed event families become bars; everything else is ignored.
    assert.match(gantt, /model\.response/);
    assert.match(gantt, /tool\.result/);
  });

  it('defines timeline panel with inspector and mounts on Sessions', () => {
    const panel = read('pages/timeline-panel.tsx');
    assert.match(panel, /export function TimelinePanel/);
    assert.match(panel, /EventInspector/);
    assert.match(panel, /parentEventId/);
    assert.match(panel, /assets\.timeline\./);
    const sessions = read('pages/sessions-page.tsx');
    assert.match(sessions, /TimelinePanel/);
  });

  it('defines topology panel over the evidence graph and mounts on Run Specs', () => {
    const topology = read('pages/topology-panel.tsx');
    assert.match(topology, /export function TopologyPanel/);
    assert.match(topology, /run-topology/);
    assert.match(topology, /RuntimeEvidenceGraph/);
    assert.match(topology, /depends_on/);
    assert.match(topology, /assets\.topology\./);
    const runs = read('pages/run-specs-page.tsx');
    assert.match(runs, /TopologyPanel/);
    assert.match(topology, /\/runs\/\$\{encodeURIComponent\(runSpecId!\)\}\/inspect/);
  });

  it('registers timeline and topology keys in both locales', () => {
    const en = read('i18n/en/assets2.ts');
    const zh = read('i18n/zh/assets2.ts');
    for (const key of ['assets.timeline.title', 'assets.timeline.selectHint', 'assets.timeline.duration',
      'assets.topology.title', 'assets.topology.stats', 'assets.topology.hint',
      'assets.subagents.title', 'assets.subagents.count']) {
      assert.match(en, new RegExp(`'${key}'`), `en missing ${key}`);
      assert.match(zh, new RegExp(`'${key}'`), `zh missing ${key}`);
    }
  });

  it('defines subagent tree over /sessions/:id/subagents and mounts on Sessions', () => {
    const tree = read('pages/subagent-tree.tsx');
    assert.match(tree, /export function SubagentTree/);
    assert.match(tree, /session-subagents/);
    assert.match(tree, /\/sessions\/\$\{encodeURIComponent\(sessionId!\)\}\/subagents/);
    assert.match(tree, /parent_run_spec_id/);
    assert.match(tree, /eventStatus/);
    assert.match(tree, /los\.activity\.session/);
    const sessions = read('pages/sessions-page.tsx');
    assert.match(sessions, /SubagentTree/);
  });

  it('backend exposes GET /sessions/:id/subagents with recursive lineage', () => {
    const subagents = read('../../../packages/agent/src/session-subagents.ts');
    assert.match(subagents, /export async function getSessionSubagents/);
    assert.match(subagents, /parent_run_spec_id/);
    assert.match(subagents, /child\.agent\./);
    assert.match(subagents, /loadLifecycleIndex/);
    const routes = read('../../../packages/gateway/src/routes/data/session-routes.ts');
    assert.match(routes, /getSessionSubagents/);
    assert.match(routes, /'\/sessions\/:id\/subagents'/);
  });

  it('projects effective model from the ledger into the sessions list', () => {
    const events = read('../../../packages/agent/src/session-events.ts');
    assert.match(events, /export async function latestEffectiveModels/);
    assert.match(events, /DISTINCT ON \(session_id\)/);
    const routes = read('../../../packages/gateway/src/routes/data/session-routes.ts');
    assert.match(routes, /latestEffectiveModels/);
    assert.match(routes, /effectiveModel/);
    const sessions = read('pages/sessions-page.tsx');
    assert.match(sessions, /session\.effectiveModel/);
    assert.match(sessions, /detail\.data\.effectiveModel/);
    const types = read('api/types-sessions.ts');
    assert.match(types, /effectiveModel/);
  });
});
