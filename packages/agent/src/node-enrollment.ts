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
  expires_at TIMESTAMPTZ,
  previous_credential_hash TEXT,
  previous_valid_until TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
ALTER TABLE node_enrollments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE node_enrollments ADD COLUMN IF NOT EXISTS previous_credential_hash TEXT;
ALTER TABLE node_enrollments ADD COLUMN IF NOT EXISTS previous_valid_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_node_enrollments_previous
  ON node_enrollments(previous_credential_hash)
  WHERE previous_credential_hash IS NOT NULL;
`;

/**
 * 凭据 TTLS（C.2 第 3 条）。
 *
 * 旧实现把 365 天只写在返回值里：`verifyNodeCredential` 从不读 `expires_at`，
 * 于是"到期"只是一句声明。现在过期进入校验，且**存量行**按 `enrolled_at + 365d`
 * 折算（它们签发时的承诺就是 365 天），新签发默认 30 天。
 */
const DEFAULT_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60_000;
/**
 * 轮换时旧凭据的**重叠窗口**。节点拿到新凭据后要落盘再切换；中间失败时旧值
 * 在这段时间里仍然有效，避免"响应丢了 / 写盘失败"直接把节点锁在门外。
 */
const NODE_CREDENTIAL_ROTATION_OVERLAP_MS = 24 * 60 * 60_000;

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

export async function redeemNodeEnrollmentToken(token: string, nodeId: string, ttlMs = DEFAULT_CREDENTIAL_TTL_MS): Promise<NodeCredential | null> {
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
        `INSERT INTO node_enrollments (node_id, credential_hash, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (node_id) DO UPDATE
           SET credential_hash = EXCLUDED.credential_hash,
               enrolled_at = now(),
               expires_at = EXCLUDED.expires_at,
               revoked_at = NULL`,
        [nodeId, credentialHash, expiresAt],
      );
      await client.query('COMMIT');
      return { nodeId, credential, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

export async function verifyNodeCredential(
  credential: string,
): Promise<{ nodeId: string; expiresAt: string } | null> {
  if (!credential) return null;
  await ensureNodeEnrollmentStore();
  // 存量行（expires_at IS NULL）按 365 天折算：它们签发时的承诺是 365 天，
  // 不能用新默认值追溯缩短。过期在 SQL 里判定，避免时钟/序列化口径分叉。
  //
  // 双凭据：`credential_hash` 是当前值；`previous_credential_hash` 只在
  // `previous_valid_until` 之前有效（轮换重叠窗口）。两条都按各自的到期时间算，
  // 不能拿当前值的 expires_at 去放行旧值。
  const result = await getDb().query<{ node_id: string; expires_at: Date; expired: boolean }>(
    `SELECT node_id,
            CASE
              WHEN credential_hash = $1 THEN COALESCE(expires_at, enrolled_at + interval '365 days')
              ELSE previous_valid_until
            END AS expires_at,
            CASE
              WHEN credential_hash = $1 THEN COALESCE(expires_at, enrolled_at + interval '365 days')
              ELSE previous_valid_until
            END <= now() AS expired
     FROM node_enrollments
     WHERE revoked_at IS NULL
       AND (credential_hash = $1
            OR (previous_credential_hash = $1 AND previous_valid_until IS NOT NULL))`,
    [hashSecret(credential)],
  );
  const row = result.rows[0];
  if (!row || row.expired) return null;
  return { nodeId: row.node_id, expiresAt: new Date(row.expires_at).toISOString() };
}

/**
 * 用**当前凭据或重叠窗口内的旧凭据**换一枚新凭据（节点自助，不需要 operator 发 token）。
 *
 * 与 `POST /nodes/enroll` 的区别：enroll 是"用一次性 token 认领节点"（运营动作），
 * rotation 是"已入网节点在到期前换钥匙"（节点动作）。旧值不会立刻失效，而是进入
 * `NODE_CREDENTIAL_ROTATION_OVERLAP_MS` 的重叠窗口，覆盖"响应丢失/写盘失败"。
 *
 * 为什么也接受 previous：节点的状态文件可能随容器/临时盘一起丢，重启后只剩 `.env`
 * 里的旧值；如果旧值此时在重叠窗口里，拒绝轮换会让它 24h 后必然掉线。允许从
 * previous 轮换时，**previous 槽保持原值、窗口不延长**（只替换 active），于是重复
 * 重启可以反复自愈，而不会把旧值变成一把永久钥匙。
 *
 * 代价：同一 nodeId 的多副本各自轮换会互相顶掉 active；节点凭据本就是"一节点一把"，
 * 不做并发多凭据。
 */
export async function rotateNodeCredential(
  currentCredential: string,
  ttlMs = DEFAULT_CREDENTIAL_TTL_MS,
  overlapMs = NODE_CREDENTIAL_ROTATION_OVERLAP_MS,
): Promise<NodeCredential | null> {
  if (!currentCredential) return null;
  await ensureNodeEnrollmentStore();
  const credential = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + Math.max(1_000, ttlMs));
  return withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const rotated = await client.query<{ node_id: string }>(
        `UPDATE node_enrollments
         SET previous_credential_hash =
               CASE WHEN credential_hash = $1 THEN credential_hash ELSE previous_credential_hash END,
             previous_valid_until =
               CASE WHEN credential_hash = $1
                    THEN LEAST(
                      COALESCE(expires_at, enrolled_at + interval '365 days'),
                      now() + ($3::text || ' milliseconds')::interval
                    )
                    ELSE previous_valid_until
               END,
             credential_hash = $2,
             expires_at = $4
         WHERE revoked_at IS NULL
           AND (
             (credential_hash = $1
              AND COALESCE(expires_at, enrolled_at + interval '365 days') > now())
             OR (previous_credential_hash = $1 AND previous_valid_until > now())
           )
         RETURNING node_id`,
        [hashSecret(currentCredential), hashSecret(credential), Math.max(1_000, overlapMs), expiresAt],
      );
      if (rotated.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('COMMIT');
      return { nodeId: rotated.rows[0].node_id, credential, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}
