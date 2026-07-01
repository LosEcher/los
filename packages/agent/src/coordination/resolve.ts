/**
 * @los/agent/coordination — Backend resolver.
 *
 * Automatically selects the appropriate coordination backend based on:
 *   LOS_MESH_MODE=0        → memory (single process)
 *   LOS_MESH_MODE=1        → PG (mesh)
 *   unset + PG available   → PG
 *   unset + PG unavailable → memory
 */

import { getLogger } from '@los/infra/logger';
import type { CoordinationBackend, CoordinationMode } from './types.js';

const log = getLogger('coordination');

let _backend: CoordinationBackend | null = null;

/**
 * Resolve the coordination backend. Result is cached — subsequent calls
 * return the same backend instance.
 *
 * The backend is resolved once per process. Toggling LOS_MESH_MODE
 * after the first call has no effect.
 */
export async function resolveCoordinationBackend(): Promise<CoordinationBackend> {
  if (_backend) return _backend;

  const explicit = readMeshMode();
  if (explicit === 'single') {
    return await initMemory();
  }
  if (explicit === 'mesh') {
    return await initPg();
  }

  // Auto-detect: try PG
  if (pgConfigured()) {
    return await initPg();
  }
  return await initMemory();
}

/**
 * Force a specific mode. Useful for tests.
 */
export function resetCoordinationBackend(): void {
  _backend = null;
}

// ── Helpers ────────────────────────────────────────────────

function readMeshMode(): CoordinationMode | null {
  const val = process.env.LOS_MESH_MODE;
  if (val === '0' || val === 'off' || val === 'single') return 'single';
  if (val === '1' || val === 'on' || val === 'mesh') return 'mesh';
  return null;
}

function pgConfigured(): boolean {
  try {
    const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
    return !!url && (url.startsWith('postgres://') || url.startsWith('postgresql://'));
  } catch {
    return false;
  }
}

async function initMemory(): Promise<CoordinationBackend> {
  const mod = await import('./memory-backend.js');
  _backend = mod.createMemoryCoordinationBackend();
  log.info(`Coordination backend: memory (single-process mode)`);
  return _backend!;
}

async function initPg(): Promise<CoordinationBackend> {
  const mod = await import('./pg-backend.js');
  _backend = mod.createPgCoordinationBackend();
  log.info(`Coordination backend: PostgreSQL (mesh mode)`);
  return _backend!;
}
