/**
 * @los/agent/object-store/fs-store — File-system backed object store.
 *
 * Layout: <baseDir>/<prefix>/<rest>
 *   e.g., ~/.los/objects/a3/b8c9d0e1f2...
 *
 * This mirrors Git's loose object store layout. Objects are stored as
 * flat files; metadata is stored alongside as <oid>.meta.json.
 *
 * Zero dependencies beyond Node.js built-ins. Suitable for:
 *  - single-mode deployments
 *  - interstellar mode (offline, self-contained)
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '@los/infra/logger';
import type { ObjectStore, ObjectMeta, OID } from './types.js';
import { computeOID, oidPathPrefix, oidPathRest } from './types.js';

const log = getLogger('object-store-fs');

// ── Backend ────────────────────────────────────────────────

export class FsObjectStore implements ObjectStore {
  private readonly baseDir: string;

  /**
   * @param baseDir Root directory for object storage.
   *                Default: ~/.los/objects
   */
  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.cwd(), '.los/objects');
  }

  async put(content: Buffer | string, opts?: { tags?: string[] }): Promise<OID> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const oid = computeOID(buf);

    // Skip if already stored (unchanged content)
    const objPath = this.objPath(oid);
    if (existsSync(objPath)) return oid;

    // Ensure directory exists
    const dir = this.objDir(oid);
    ensureDir(dir);

    // Write object file
    try {
      writeFileSync(objPath, buf);
    } catch (err) {
      log.warn(`Failed to write object ${oid.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      return oid;
    }

    // Write metadata
    const meta: ObjectMeta = {
      oid,
      sizeBytes: buf.length,
      tags: opts?.tags ?? [],
      createdAt: new Date().toISOString(),
    };
    this.writeMeta(oid, meta);

    return oid;
  }

  async get(oid: OID): Promise<Buffer | null> {
    const objPath = this.objPath(oid);
    if (!existsSync(objPath)) return null;
    try {
      return readFileSync(objPath);
    } catch {
      return null;
    }
  }

  async exists(oid: OID): Promise<boolean> {
    return existsSync(this.objPath(oid));
  }

  async verify(oid: OID): Promise<boolean> {
    const content = await this.get(oid);
    if (!content) return false;
    return computeOID(content) === oid;
  }

  async meta(oid: OID): Promise<ObjectMeta | null> {
    const metaPath = this.metaPath(oid);
    if (!existsSync(metaPath)) {
      // Infer from file
      const objPath = this.objPath(oid);
      if (!existsSync(objPath)) return null;
      const stat = await import('node:fs').then(fs => fs.statSync(objPath));
      return {
        oid,
        sizeBytes: stat.size,
        tags: [],
        createdAt: stat.birthtime.toISOString(),
      };
    }
    try {
      return JSON.parse(readFileSync(metaPath, 'utf-8')) as ObjectMeta;
    } catch {
      return null;
    }
  }

  async delete(oid: OID): Promise<boolean> {
    const objPath = this.objPath(oid);
    const metaPath = this.metaPath(oid);
    let deleted = false;
    try {
      if (existsSync(objPath)) { unlinkSync(objPath); deleted = true; }
      if (existsSync(metaPath)) unlinkSync(metaPath);
    } catch { /* ok */ }
    return deleted;
  }

  // ── Paths ─────────────────────────────────────────────────

  private objDir(oid: OID): string {
    return join(this.baseDir, oidPathPrefix(oid));
  }

  private objPath(oid: OID): string {
    return join(this.baseDir, oidPathPrefix(oid), oidPathRest(oid));
  }

  private metaPath(oid: OID): string {
    return join(this.baseDir, oidPathPrefix(oid), `${oidPathRest(oid)}.meta.json`);
  }

  private writeMeta(oid: OID, meta: ObjectMeta): void {
    try {
      writeFileSync(this.metaPath(oid), JSON.stringify(meta), 'utf-8');
    } catch { /* best-effort */ }
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
