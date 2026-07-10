import { getDb } from '@los/infra/db';

export const WXPUSHER_CALLBACK_CLAIM_SCHEMA = `
CREATE TABLE IF NOT EXISTS wxpusher_callback_claims (
  replay_key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wxpusher_callback_claims_state_chk
    CHECK (state IN ('processing', 'accepted', 'completed', 'failed'))
);

ALTER TABLE wxpusher_callback_claims
  ADD COLUMN IF NOT EXISTS failure_code TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wxpusher_callback_claims_state_chk'
      AND conrelid = 'wxpusher_callback_claims'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%accepted%'
  ) THEN
    ALTER TABLE wxpusher_callback_claims
      DROP CONSTRAINT wxpusher_callback_claims_state_chk;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wxpusher_callback_claims_state_chk'
      AND conrelid = 'wxpusher_callback_claims'::regclass
  ) THEN
    ALTER TABLE wxpusher_callback_claims
      ADD CONSTRAINT wxpusher_callback_claims_state_chk
      CHECK (state IN ('processing', 'accepted', 'completed', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_wxpusher_callback_claims_expires
  ON wxpusher_callback_claims(expires_at);
`;

export interface WxPusherCallbackClaimInput {
  replayKey: string;
  leaseOwner: string;
  leaseMs: number;
  expiresAt: string;
}

let initialized = false;

export async function ensureWxPusherCallbackClaimStore(): Promise<void> {
  if (initialized) return;
  await getDb().exec(WXPUSHER_CALLBACK_CLAIM_SCHEMA);
  initialized = true;
}

export async function claimWxPusherCallback(input: WxPusherCallbackClaimInput): Promise<boolean> {
  await ensureWxPusherCallbackClaimStore();
  const db = getDb();
  await db.query(`
    DELETE FROM wxpusher_callback_claims
    WHERE (state IN ('completed', 'failed') AND expires_at <= now())
       OR (state = 'processing' AND lease_expires_at <= now())
  `);
  const result = await db.query<{ replay_key: string }>(
    `
    INSERT INTO wxpusher_callback_claims (
      replay_key, state, lease_owner, lease_expires_at, expires_at
    ) VALUES (
      $1, 'processing', $2,
      now() + ($3::text || ' milliseconds')::interval,
      $4::timestamptz
    )
    ON CONFLICT (replay_key) DO UPDATE SET
      state = 'processing',
      lease_owner = EXCLUDED.lease_owner,
      lease_expires_at = EXCLUDED.lease_expires_at,
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
    WHERE (
         wxpusher_callback_claims.state IN ('completed', 'failed')
         AND wxpusher_callback_claims.expires_at <= now()
       )
       OR (
         wxpusher_callback_claims.state = 'processing'
         AND wxpusher_callback_claims.lease_expires_at <= now()
       )
    RETURNING replay_key
    `,
    [input.replayKey, input.leaseOwner, input.leaseMs, input.expiresAt],
  );
  return result.rows.length === 1;
}

export async function acceptWxPusherCallback(
  replayKey: string,
  leaseOwner: string,
  expiresAt: string,
): Promise<boolean> {
  await ensureWxPusherCallbackClaimStore();
  const result = await getDb().query<{ replay_key: string }>(
    `
    UPDATE wxpusher_callback_claims
    SET state = 'accepted',
        lease_owner = NULL,
        lease_expires_at = NULL,
        expires_at = $3::timestamptz,
        failure_code = NULL,
        updated_at = now()
    WHERE replay_key = $1
      AND state = 'processing'
      AND lease_owner = $2
    RETURNING replay_key
    `,
    [replayKey, leaseOwner, expiresAt],
  );
  return result.rows.length === 1;
}

export async function completeWxPusherCallback(replayKey: string): Promise<boolean> {
  await ensureWxPusherCallbackClaimStore();
  const result = await getDb().query<{ replay_key: string }>(
    `
    UPDATE wxpusher_callback_claims
    SET state = 'completed', updated_at = now()
    WHERE replay_key = $1 AND state = 'accepted'
    RETURNING replay_key
    `,
    [replayKey],
  );
  return result.rows.length === 1;
}

export async function failWxPusherCallback(replayKey: string, failureCode: string): Promise<boolean> {
  await ensureWxPusherCallbackClaimStore();
  const result = await getDb().query<{ replay_key: string }>(
    `
    UPDATE wxpusher_callback_claims
    SET state = 'failed', failure_code = $2, updated_at = now()
    WHERE replay_key = $1 AND state = 'accepted'
    RETURNING replay_key
    `,
    [replayKey, failureCode],
  );
  return result.rows.length === 1;
}

export async function releaseProcessingWxPusherCallback(replayKey: string, leaseOwner: string): Promise<void> {
  await ensureWxPusherCallbackClaimStore();
  await getDb().query(
    `DELETE FROM wxpusher_callback_claims
     WHERE replay_key = $1 AND state = 'processing' AND lease_owner = $2`,
    [replayKey, leaseOwner],
  );
}
