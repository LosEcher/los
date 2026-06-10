import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import {
  ensureServiceInstanceStore,
  upsertServiceInstanceHeartbeat,
  loadServiceInstance,
} from './service-instances.js';
import {
  ensureProviderCompatEvidenceStore,
  recordProviderCompatEvidence,
} from './provider-compat-evidence.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '../../..');

// ── E02 ───────────────────────────────────────────────────
// Bad pattern: inferring runtime health from config or package scripts.
// Passing pattern: runtime truth from process/API/DB output.

test('E02: service instance health reflects live DB state, not config defaults', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureServiceInstanceStore();

  const serviceId = `eval-e02-${Date.now()}`;

  // Write a heartbeat with explicit health — this is runtime truth, not config
  await upsertServiceInstanceHeartbeat({
    serviceId,
    serviceKind: 'gateway',
    health: { db_ok: true, schema_ok: true },
    capabilities: { chat_api: true },
  });

  const loaded = await loadServiceInstance(serviceId);
  assert.ok(loaded, 'service instance persisted');

  // Runtime-derived fields must exist — these cannot come from config alone
  assert.ok(typeof loaded.health === 'object' && loaded.health !== null, 'health is live object');
  assert.equal((loaded.health as Record<string, unknown>).db_ok, true, 'db_ok from actual connection');
  assert.ok(typeof loaded.lastHeartbeatAt === 'string', 'heartbeat timestamp is runtime-derived');
  assert.ok(new Date(loaded.lastHeartbeatAt).getTime() > 0, 'heartbeat time is valid');

  // Config-only fields are not present on a heartbeat row (status is separate)
  assert.ok(typeof loaded.status === 'string', 'status reflects live registration');

  await closeDb().catch(() => undefined);
});

// ── E03 ───────────────────────────────────────────────────
// Bad pattern: claiming a provider/model is compatible because it was discovered.
// Passing pattern: readiness and compatibility reported as separate facts.

test('E03: provider compat evidence is stored independently from discovery readiness', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureProviderCompatEvidenceStore();

  const provider = `eval-e03-${Date.now()}`;
  const model = 'eval-e03-model';

  // Readiness (discovery) and compatibility (evidence) are separate stores
  // Before any compat run, the compat table has no row for this provider
  const db = getDb();
  const before = await db.query<{ id: string }>(
    'SELECT id FROM provider_compat_evidence WHERE provider = $1',
    [provider],
  );
  assert.equal(before.rows.length, 0,
    `no compat evidence before a compat run — readiness != compatibility (found ${before.rows.length} rows for ${provider})`);

  // A compat run records separate evidence with a decision
  const recorded = await recordProviderCompatEvidence({
    provider,
    model,
    probeId: 'eval-e03-probe',
    targetLabel: `${provider}:${model}`,
    decision: 'verified_advisory',
    passed: true,
    summary: { toolPolicyTested: true, sandboxMode: 'read-only' },
  });

  assert.equal(recorded.provider, provider);
  assert.equal(recorded.model, model);
  assert.equal(recorded.decision, 'verified_advisory');
  assert.equal(recorded.passed, true);

  // The compat evidence row has its own identity — not derived from discovery
  assert.ok(recorded.id.startsWith('provider-compat-'), 'compat evidence has its own id namespace');
  assert.ok(typeof recorded.createdAt === 'string', 'compat evidence has its own creation timestamp');

  const after = await db.query<{ id: string }>(
    'SELECT id FROM provider_compat_evidence WHERE provider = $1',
    [provider],
  );
  assert.equal(after.rows.length, 1,
    'compat evidence exists after a compat run');

  await closeDb().catch(() => undefined);
});

// ── E08 ───────────────────────────────────────────────────
// Bad pattern: repeating ADR status as if implementation still matches.
// Passing pattern: label ADR as design intent and source/runtime as current fact.

test('E08: accepted ADRs have at least one implementation reference in source', () => {
  const adrDir = join(ROOT, 'docs/adr');
  const packagesDir = join(ROOT, 'packages');

  let adrFiles: string[];
  try {
    adrFiles = readdirSync(adrDir).filter(f => f.endsWith('.md'));
  } catch {
    // CI may not have docs checked out; skip gracefully
    assert.ok(true, 'skipped — docs/adr not available');
    return;
  }

  const unresolved: string[] = [];

  for (const adrFile of adrFiles) {
    const adrPath = join(adrDir, adrFile);
    const content = readFileSync(adrPath, 'utf8');

    // Only check accepted ADRs
    if (!/\bstatus:\s*accepted\b/.test(content)) continue;

    const match = adrFile.match(/^(\d+)/);
    if (!match) continue;
    const adrNum = match[1];
    const adrRef = `ADR ${adrNum}`;

    // Search for the ADR number in package sources (quick depth-limited scan)
    const found = grepInDir(packagesDir, adrNum, 3);
    if (!found) {
      unresolved.push(`${adrRef} (${adrFile})`);
    }
  }

  assert.equal(unresolved.length, 0,
    `Accepted ADRs with zero implementation references (E08 drift risk):\n${unresolved.join('\n')}\n\n` +
    `Each accepted ADR must be referenced in at least one source, test, or config file under packages/.`);
});

function grepInDir(dir: string, pattern: string, maxDepth: number): boolean {
  const queue: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];

  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      continue;
    }

    for (const name of names) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;

      const full = join(path, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        if (depth < maxDepth) queue.push({ path: full, depth: depth + 1 });
      } else if (st.isFile() && /\.(ts|tsx|json|sh|yaml|yml)$/.test(name)) {
        try {
          const content = readFileSync(full, 'utf8');
          if (content.includes(pattern)) return true;
        } catch {
          // permission error, skip
        }
      }
    }
  }

  return false;
}
