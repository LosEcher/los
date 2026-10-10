/**
 * Client data-access boundary (ADR 0048 / audit migration items D12 + D2).
 *
 * Why this exists: D12's guarantee — "a stale whole-table response must never
 * overwrite a newer one" — is not implemented in this repo. It is inherited from
 * React Query's `cancelRefetch` semantics (default `true`; see the query-core
 * evidence recorded in the adoption plan). That inheritance holds **only as long as
 * list reads go through the query client**. A page that grows its own `fetch()`
 * list read silently loses the guarantee.
 *
 * So this test locks the boundary that the guarantee depends on: raw network
 * primitives may appear only in the modules that own the transport. Everything else
 * must use the api client (which the query hooks call) or a stream hook.
 *
 * It is deliberately the same "enumerate + explicit allowlist" shape as
 * `tools/check-route-admission.mjs`: adding a new transport module is a deliberate
 * edit to ALLOWED below, and a renamed module fails the existence assertion instead
 * of silently widening the boundary.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = HERE;

/** Modules that are allowed to touch the network directly. */
const ALLOWED = new Set([
  'api/client.ts', // HTTP transport (getJson/postJson/…) used by every query hook
  'api/ws-client.ts', // session WebSocket transport
  'hooks/useChatStream.ts', // session SSE transport
]);

/** Raw network primitives. `\b` keeps `refetch(` from matching. */
const RAW_NETWORK = /\b(?:fetch|new EventSource|new WebSocket)\s*\(/;

/** Exported for the self-test below; pure over its input. */
export function findRawNetworkUses(source) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    // Ignore comments: a commented-out fetch is documentation, not transport.
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    if (RAW_NETWORK.test(code)) hits.push({ line: index + 1, text: line.trim() });
  });
  return hits;
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      yield* sourceFiles(full);
      continue;
    }
    if (!/\.(?:ts|tsx|mjs)$/.test(full)) continue;
    if (/\.d\.mts$/.test(full) || /\.test\.mjs$/.test(full)) continue;
    yield full;
  }
}

test('the detector ignores refetch( and comments (guards against a silent no-op gate)', () => {
  assert.deepEqual(findRawNetworkUses('void list.refetch();'), []);
  assert.deepEqual(findRawNetworkUses('// await fetch("/x")'), []);
  assert.equal(findRawNetworkUses('const r = await fetch("/x");').length, 1);
  assert.equal(findRawNetworkUses('new EventSource("/x")').length, 1);
  assert.equal(findRawNetworkUses('new WebSocket("/x")').length, 1);
});

test('raw network access is confined to the transport modules', () => {
  const offenders = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    const hits = findRawNetworkUses(readFileSync(file, 'utf8'));
    if (hits.length === 0) continue;
    if (ALLOWED.has(rel)) continue;
    for (const hit of hits) offenders.push(`${rel}:${hit.line}  ${hit.text}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these modules reach the network directly; route them through src/api/client.ts (and a query hook) ' +
      'instead, or add the module to ALLOWED in this test with a reason:\n' + offenders.join('\n'),
  );
});

test('every allowed transport module still exists (a rename must fail, not silently widen)', () => {
  for (const rel of ALLOWED) {
    const hits = findRawNetworkUses(readFileSync(join(SRC, rel), 'utf8'));
    assert.ok(hits.length > 0, `${rel} is allowed to use the network but no longer does — update ALLOWED`);
  }
});
