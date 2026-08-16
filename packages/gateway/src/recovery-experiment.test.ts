import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { RECOVERY_SCENARIOS, runRecoveryExperiment } from './recovery-experiment.js';

const CLEANUP_PATTERNS = [
  ['DELETE FROM task_runs WHERE id LIKE $1', 'task-drill-%'],
  ['DELETE FROM task_runs WHERE session_id LIKE $1', 'drill-%'],
  ['DELETE FROM run_specs WHERE id LIKE $1', 'run-drill-%'],
  ['DELETE FROM session_events WHERE session_id LIKE $1', 'drill-%'],
  ['DELETE FROM dead_letter_events WHERE payload_json::text LIKE $1', '%drill%'],
  ['DELETE FROM execution_outbox WHERE session_id LIKE $1', 'drill-%'],
];

async function cleanup(suffix: string): Promise<void> {
  for (const [sql, pattern] of CLEANUP_PATTERNS) {
    await getDb().query(sql, [pattern.replace('%', `%${suffix}%`)]).catch(() => undefined);
  }
}

test('recovery drill: lease_expired reaps the task and writes a dead letter', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const result = await runRecoveryExperiment('lease_expired', { suffix });
    assert.equal(result.scenario, 'lease_expired');
    assert.equal(result.passed, true, JSON.stringify(result.assertions));
    assert.ok(result.evidence.length > 0);
  } finally {
    await cleanup(suffix);
    await closeDb().catch(() => undefined);
  }
});

test('recovery drill: process_terminated re-dispatches the approved run', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const result = await runRecoveryExperiment('process_terminated', { suffix });
    assert.equal(result.passed, true, JSON.stringify(result.assertions));
  } finally {
    await cleanup(suffix);
    await closeDb().catch(() => undefined);
  }
});

test('recovery drill: sse_interrupted replays the persisted ledger without loss', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const result = await runRecoveryExperiment('sse_interrupted', { suffix });
    assert.equal(result.passed, true, JSON.stringify(result.assertions));
  } finally {
    await cleanup(suffix);
    await closeDb().catch(() => undefined);
  }
});

test('recovery drill: db_unavailable drains the backlogged outbox after recovery', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const result = await runRecoveryExperiment('db_unavailable', { suffix });
    assert.equal(result.passed, true, JSON.stringify(result.assertions));
  } finally {
    await cleanup(suffix);
    await closeDb().catch(() => undefined);
  }
});

test('recovery drill: executor_disconnected opens the circuit until a success resets it', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const result = await runRecoveryExperiment('executor_disconnected', { suffix });
    assert.equal(result.passed, true, JSON.stringify(result.assertions));
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('recovery drill: every scenario in the catalog is runnable', () => {
  assert.deepEqual(
    RECOVERY_SCENARIOS,
    ['lease_expired', 'process_terminated', 'sse_interrupted', 'db_unavailable', 'executor_disconnected'],
  );
});
