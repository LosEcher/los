/**
 * Report-artifact recording tests — hermetic (tmpdir only, no DB, no network).
 *
 * Regression guard for the mis-attributed `resultSummary.reportPath` observed
 * 2026-10-06: the surge analysis wrote
 * `surge-reports/<ts>-surge-analysis.md` but the run ledger recorded
 * `reports/<ts>-analysis.md`. Cause: `findLatestReport` hardcoded
 * `<editableSurfaces[i]>/reports`, and both analysis tasks share the parent
 * surface `.los-runtime/network-observe`, so the surge task could only ever
 * name the network report. The template-level `reportDir` now overrides that.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findLatestReport } from './runner.js';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'los-report-dir-'));
  // Layout mirrors .los-runtime/network-observe: a shared parent holding two
  // sibling report directories written by two different scheduled tasks.
  await mkdir(join(root, 'reports'), { recursive: true });
  await mkdir(join(root, 'surge-reports'), { recursive: true });
  await writeFile(join(root, 'reports', '2026-10-06T10-02-48-269Z-analysis.md'), '# network\n');
  await writeFile(join(root, 'surge-reports', '2026-10-06T10-26-01-surge-analysis.md'), '# surge\n');
  // Make the NETWORK report the newest by mtime — the exact condition under
  // which the old code picked it for the surge task.
  const now = Date.now() / 1000;
  await utimes(join(root, 'reports', '2026-10-06T10-02-48-269Z-analysis.md'), now, now);
  await utimes(join(root, 'surge-reports', '2026-10-06T10-26-01-surge-analysis.md'), now - 600, now - 600);
  // A non-markdown sibling must be ignored.
  await writeFile(join(root, 'surge-reports', 'notes.txt'), 'ignore me\n');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findLatestReport', () => {
  it('records the task own directory when reportDir is set (surge task)', async () => {
    const path = await findLatestReport([root], join(root, 'surge-reports'));
    assert.equal(path, join(root, 'surge-reports', '2026-10-06T10-26-01-surge-analysis.md'));
  });

  it('records the sibling task own directory too (network task)', async () => {
    const path = await findLatestReport([root], join(root, 'reports'));
    assert.equal(path, join(root, 'reports', '2026-10-06T10-02-48-269Z-analysis.md'));
  });

  it('falls back to <surface>/reports when reportDir is absent (legacy shape)', async () => {
    const path = await findLatestReport([root]);
    assert.equal(path, join(root, 'reports', '2026-10-06T10-02-48-269Z-analysis.md'));
  });

  it('treats an empty reportDir as absent rather than as a directory', async () => {
    const path = await findLatestReport([root], '');
    assert.equal(path, join(root, 'reports', '2026-10-06T10-02-48-269Z-analysis.md'));
  });

  it('returns undefined when neither surface nor reportDir holds reports', async () => {
    assert.equal(await findLatestReport(undefined, undefined), undefined);
    assert.equal(await findLatestReport([], undefined), undefined);
    assert.equal(await findLatestReport([join(root, 'nope')]), undefined);
    assert.equal(await findLatestReport([root], join(root, 'missing-reports')), undefined);
  });
});
