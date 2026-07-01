/**
 * @los/agent/object-store — Content-addressed object storage.
 *
 * All objects are identified by their SHA-256 hash (OID). This provides:
 *  - Deduplication: identical content → same OID
 *  - Integrity: every read can verify content matches OID
 *  - Immutability: OIDs are forever (content is never mutated)
 *
 * Physical storage:
 *  - fs-store:   ~/.los/objects/<prefix>/<rest>  (single-mode, zero deps)
 *  - pg-store:   PG objects table                 (mesh mode, shared access)
 *  - hybrid:     small objects → PG, large → FS
 *
 * OID = hex-encoded SHA-256 of content.
 * Path prefix = first 2 chars of OID (like Git's loose objects).
 */

import { createHash } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────

/** Object ID — hex-encoded SHA-256 of the object content. */
export type OID = string;

export interface ObjectMeta {
  oid: OID;
  sizeBytes: number;
  tags: string[];
  createdAt: string;
}

export interface ObjectStore {
  /** Store content and return its OID. */
  put(content: Buffer | string, opts?: { tags?: string[] }): Promise<OID>;

  /** Retrieve content by OID. Returns null if not found. */
  get(oid: OID): Promise<Buffer | null>;

  /** Check if an object exists. */
  exists(oid: OID): Promise<boolean>;

  /** Verify content integrity (sha256 matches OID). */
  verify(oid: OID): Promise<boolean>;

  /** Get metadata for an object. */
  meta(oid: OID): Promise<ObjectMeta | null>;

  /** Delete an object. Irreversible. */
  delete(oid: OID): Promise<boolean>;
}

// ── OID helpers ────────────────────────────────────────────

export function computeOID(content: Buffer | string): OID {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

export function oidPathPrefix(oid: OID): string {
  return oid.slice(0, 2);
}

export function oidPathRest(oid: OID): string {
  return oid.slice(2);
}
