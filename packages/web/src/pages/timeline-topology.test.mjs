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
      'assets.topology.title', 'assets.topology.stats', 'assets.topology.hint']) {
      assert.match(en, new RegExp(`'${key}'`), `en missing ${key}`);
      assert.match(zh, new RegExp(`'${key}'`), `zh missing ${key}`);
    }
  });
});
