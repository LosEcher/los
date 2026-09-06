import { createHash, randomBytes } from 'node:crypto';
import { getDb, withDbClient } from '@los/infra/db';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS node_enrollment_tokens (
  token_hash TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_node_enrollment_tokens_expiry ON node_enrollment_tokens(expires_at);
CREATE TABLE IF NOT EXISTS node_enrollments (
  node_id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
`;

let initialized = false;

export type EnrollmentToken = { token: string; nodeId: string; expiresAt: string };
export type NodeCredential = { nodeId: string; credential: string; expiresAt: string };

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function ensureNodeEnrollmentStore(): Promise<void> {
  if (initialized) return;
  await getDb().exec(SCHEMA);
  initialized = true;
}

export async function issueNodeEnrollmentToken(nodeId: string, ttlMs = 15 * 60_000): Promise<EnrollmentToken> {
  await ensureNodeEnrollmentStore();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + Math.max(1_000, ttlMs));
  await getDb().query(
    'INSERT INTO node_enrollment_tokens (token_hash, node_id, expires_at) VALUES ($1, $2, $3)',
    [hashSecret(token), nodeId, expiresAt],
  );
  return { token, nodeId, expiresAt: expiresAt.toISOString() };
}

export async function redeemNodeEnrollmentToken(token: string, nodeId: string, ttlMs = 365 * 24 * 60 * 60_000): Promise<NodeCredential | null> {
  await ensureNodeEnrollmentStore();
  const credential = randomBytes(32).toString('base64url');
  const credentialHash = hashSecret(credential);
  const expiresAt = new Date(Date.now() + ttlMs);
  return withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const consumed = await client.query<{ node_id: string }>(
        `UPDATE node_enrollment_tokens
         SET consumed_at = now()
         WHERE token_hash = $1 AND node_id = $2 AND consumed_at IS NULL AND expires_at > now()
         RETURNING node_id`,
        [hashSecret(token), nodeId],
      );
      if (consumed.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `INSERT INTO node_enrollments (node_id, credential_hash)
         VALUES ($1, $2)
         ON CONFLICT (node_id) DO UPDATE SET credential_hash = EXCLUDED.credential_hash, enrolled_at = now(), revoked_at = NULL`,
        [nodeId, credentialHash],
      );
      await client.query('COMMIT');
      return { nodeId, credential, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

export async function verifyNodeCredential(credential: string): Promise<{ nodeId: string } | null> {
  if (!credential) return null;
  await ensureNodeEnrollmentStore();
  const result = await getDb().query<{ node_id: string }>(
    'SELECT node_id FROM node_enrollments WHERE credential_hash = $1 AND revoked_at IS NULL',
    [hashSecret(credential)],
  );
  return result.rows[0] ? { nodeId: result.rows[0].node_id } : null;
}
