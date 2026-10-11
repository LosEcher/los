/**
 * Startup route-admission reconciliation (ADR 0048 decision 2, warn-only).
 *
 * The diff rules are private to the guard, so they are exercised here through the
 * guard itself with a capturing logger — which is also the wiring being tested.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Logger } from '@los/infra/logger';

import { registerRouteAdmissionGuard } from './route-admission-guard.js';

function capturingLogger(warnings: string[]): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg: string) => { warnings.push(msg); },
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

async function warningsFor(
  register: (app: ReturnType<typeof Fastify>) => void,
): Promise<string[]> {
  const warnings: string[] = [];
  const app = Fastify({ logger: false });
  registerRouteAdmissionGuard(app, { logger: capturingLogger(warnings) });
  register(app);
  try {
    await app.ready();
  } finally {
    await app.close();
  }
  return warnings;
}

test('a classified route is not reported as drift', async () => {
  // `GET /tasks` is in the generated inventory, so it must produce no `unknown` entry.
  const warnings = await warningsFor(app => {
    app.get('/tasks', async () => ({ ok: true }));
  });
  assert.equal(
    warnings.some(w => w.includes('unclassified route registered at startup: GET /tasks')),
    false,
  );
});

test('an unclassified route is reported by name, in the unknown direction only', async () => {
  const warnings = await warningsFor(app => {
    app.post('/invented/route', async () => ({ ok: true }));
  });
  assert.equal(
    warnings.some(w => w.includes('unclassified route registered at startup: POST /invented/route')),
    true,
    'an unclassified route must be reported by name',
  );
});

test('an inventory entry that is never registered is reported (stale generated list)', async () => {
  // Registering nothing means every inventory entry is "missing" — the reverse
  // direction of the same invariant.
  const warnings = await warningsFor(() => undefined);
  assert.equal(
    warnings.filter(w => w.includes('route on the admission inventory was never registered:')).length,
    (await import('./route-admission-inventory.js')).admissionRouteKeys().length,
    'every inventory entry must be reported when nothing is registered',
  );
});

test('plugin-contributed routes and auto-generated HEAD routes are not reported', async () => {
  const warnings = await warningsFor(app => {
    // Emulates @fastify/static's wildcard plus a GET handler (which makes Fastify
    // auto-generate HEAD /tasks).
    app.get('/*', async () => ({ ok: true }));
    app.get('/tasks', async () => ({ ok: true }));
  });
  assert.equal(warnings.some(w => w.includes('GET /*')), false, 'plugin wildcard must be ignored');
  assert.equal(warnings.some(w => w.includes('HEAD ')), false, 'auto-generated HEAD must be ignored');
});
