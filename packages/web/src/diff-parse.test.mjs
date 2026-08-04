import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSideBySideRows, collapseLargeHunks, parseDiffFileLines } from './diff-parse.mjs';

const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1234567..89abcde 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,5 +1,6 @@',
  ' import { x } from \'./x\';',
  '-const old = 1;',
  '+const now = 1;',
  '+const extra = 2;',
  ' context line',
  '@@ -10 +11,2 @@',
  '-only',
  '+kept',
  '+added',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..abcdef0',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+line one',
  '+line two',
].join('\n');

test('parseDiffFileLines splits files and counts added/removed', () => {
  const files = parseDiffFileLines(SAMPLE);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/a.ts');
  assert.equal(files[0].added, 4);
  assert.equal(files[0].removed, 2);
  assert.equal(files[0].isNew, false);
  assert.equal(files[1].path, 'src/new.ts');
  assert.equal(files[1].isNew, true);
  assert.equal(files[1].added, 2);
  assert.equal(files[1].removed, 0);
});

test('hunk headers seed old/new line cursors and track line numbers', () => {
  const [file] = parseDiffFileLines(SAMPLE);
  const lines = file.lines.filter(l => l.type !== 'meta');
  assert.equal(lines[0].type, 'hunk');
  assert.equal(lines[0].oldLine, 1);
  assert.equal(lines[0].newLine, 1);
  const ctx = lines[1];
  assert.deepEqual([ctx.type, ctx.oldLine, ctx.newLine, ctx.text], ['ctx', 1, 1, " import { x } from './x';"]);
  const del = lines[2];
  assert.deepEqual([del.type, del.oldLine, del.newLine, del.text], ['del', 2, null, 'const old = 1;']);
  const add1 = lines[3];
  assert.deepEqual([add1.type, add1.oldLine, add1.newLine, add1.text], ['add', null, 2, 'const now = 1;']);
  const add2 = lines[4];
  assert.deepEqual([add2.type, add2.oldLine, add2.newLine, add2.text], ['add', null, 3, 'const extra = 2;']);
  const ctx2 = lines[5];
  assert.deepEqual([ctx2.oldLine, ctx2.newLine], [3, 4]);
});

test('second hunk re-seeds cursors with omitted counts', () => {
  const [file] = parseDiffFileLines(SAMPLE);
  const lines = file.lines.filter(l => l.type !== 'meta');
  const hunk = lines[6];
  assert.equal(hunk.type, 'hunk');
  assert.equal(hunk.oldLine, 10);
  assert.equal(hunk.newLine, 11);
  const only = lines[7];
  assert.deepEqual([only.type, only.oldLine, only.newLine], ['del', 10, null]);
  const kept = lines[8];
  assert.deepEqual([kept.type, kept.oldLine, kept.newLine], ['add', null, 11]);
  const added = lines[9];
  assert.deepEqual([added.type, added.oldLine, added.newLine], ['add', null, 12]);
});

test('binary and no-newline markers do not consume line numbers', () => {
  const diff = [
    'diff --git a/data.bin b/data.bin',
    'index 111..222 100644',
    'Binary files a/data.bin and b/data.bin differ',
    'diff --git a/src/x.ts b/src/x.ts',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -3 +3 @@',
    ' keep',
    '-gone',
    '\\ No newline at end of file',
  ].join('\n');
  const files = parseDiffFileLines(diff);
  assert.equal(files[0].isBinary, true);
  const [file] = files.slice(1);
  assert.equal(file.isBinary, false);
  const keep = file.lines.find(l => l.type === 'ctx');
  assert.deepEqual([keep.oldLine, keep.newLine], [3, 3]);
  const gone = file.lines.find(l => l.type === 'del');
  assert.deepEqual([gone.oldLine, gone.newLine], [4, null]);
  assert.equal(file.lines.some(l => l.text === '\\ No newline at end of file'), true);
});

test('rename metadata keeps both paths', () => {
  const diff = [
    'diff --git a/src/old.ts b/src/new-name.ts',
    'similarity index 92%',
    'rename from src/old.ts',
    'rename to src/new-name.ts',
  ].join('\n');
  const [file] = parseDiffFileLines(diff);
  assert.equal(file.path, 'src/new-name.ts');
  assert.equal(file.oldPath, 'src/old.ts');
});

test('collapseLargeHunks keeps small files and marks large ones', () => {
  const lines = Array.from({ length: 80 }, (_, i) => ({ type: 'ctx', oldLine: i + 1, newLine: i + 1, text: `line ${i}` }));
  const small = { path: 'a', oldPath: null, isNew: false, isDeleted: false, isBinary: false, added: 0, removed: 0, lines: lines.slice(0, 10) };
  assert.equal(collapseLargeHunks(small).lines.length, 10);

  const large = { ...small, lines };
  const collapsed = collapseLargeHunks(large);
  assert.equal(collapsed.lines.length, 61);
  const marker = collapsed.lines[60];
  assert.equal(marker.type, 'meta');
  assert.match(marker.text, /20 more lines/);
});

test('buildSideBySideRows pairs replacement blocks and keeps context on both sides', () => {
  const lines = [
    { type: 'hunk', oldLine: 1, newLine: 1, text: '@@ -1,4 +1,3 @@' },
    { type: 'ctx', oldLine: 1, newLine: 1, text: 'keep' },
    { type: 'del', oldLine: 2, newLine: null, text: 'old-a' },
    { type: 'del', oldLine: 3, newLine: null, text: 'old-b' },
    { type: 'add', newLine: 2, oldLine: null, text: 'new-a' },
    { type: 'add', newLine: 3, oldLine: null, text: 'new-b' },
    { type: 'add', newLine: 4, oldLine: null, text: 'new-c' },
    { type: 'ctx', oldLine: 4, newLine: 5, text: 'tail' },
  ];
  const rows = buildSideBySideRows(lines);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].full, true, 'hunk spans full width');
  assert.equal(rows[1].left.text, 'keep');
  assert.equal(rows[1].right.text, 'keep');
  // replacement block: 3 rows, left old / right new aligned
  assert.equal(rows[2].left.text, 'old-a');
  assert.equal(rows[2].right.text, 'new-a');
  assert.equal(rows[3].left.text, 'old-b');
  assert.equal(rows[3].right.text, 'new-b');
  assert.equal(rows[4].left, null);
  assert.equal(rows[4].right.text, 'new-c');
  assert.equal(rows[5].left.text, 'tail');
});

test('buildSideBySideRows handles standalone additions', () => {
  const rows = buildSideBySideRows([
    { type: 'add', oldLine: null, newLine: 1, text: 'only-new' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].left, null);
  assert.equal(rows[0].right.text, 'only-new');
});
