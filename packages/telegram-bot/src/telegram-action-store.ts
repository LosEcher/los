import { getDb, withDbClient } from '@los/infra/db';
import type { TelegramActionTarget } from './action-registry.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_action_tokens (
  token TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('approve', 'deny', 'escalate')),
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL DEFAULT '',
  decision_group_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'consumed')),
  claim_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  consumed_callback_id TEXT,
  consumed_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

ALTER TABLE telegram_action_tokens
  ADD COLUMN IF NOT EXISTS decision_group_id TEXT;
UPDATE telegram_action_tokens
  SET decision_group_id = token
  WHERE decision_group_id IS NULL;
ALTER TABLE telegram_action_tokens
  ALTER COLUMN decision_group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_action_tokens_expiry
  ON telegram_action_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_telegram_action_tokens_status_lease
  ON telegram_action_tokens(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_telegram_action_tokens_decision_group
  ON telegram_action_tokens(decision_group_id);
`;

let initialized = false;

export interface TelegramActionEntry {
  token: string;
  decisionGroupId: string;
  target: TelegramActionTarget;
  expiresAt: Date;
}

export type TelegramActionClaim =
  | { status: 'claimed'; decisionGroupId: string; target: TelegramActionTarget }
  | { status: 'consumed' | 'processing' | 'invalid' };

interface ActionRow {
  token: string;
  action: string;
  session_id: string;
  call_id: string;
  decision_group_id: string;
  status: string;
  claim_id: string | null;
  lease_expires_at: Date | string | null;
  expires_at: Date | string;
}

export async function ensureTelegramActionStore(): Promise<void> {
  if (initialized) return;
  await getDb().exec(SCHEMA);
  initialized = true;
}

export async function insertTelegramActionEntries(entries: readonly TelegramActionEntry[]): Promise<boolean> {
  await ensureTelegramActionStore();
  return withDbClient(async client => {
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM telegram_action_tokens WHERE expires_at <= now()');
      for (const entry of entries) {
        const inserted = await client.query(
          `
          INSERT INTO telegram_action_tokens (
            token, action, session_id, call_id, decision_group_id, status, expires_at
          )
          VALUES ($1, $2, $3, $4, $5, 'pending', $6)
          ON CONFLICT (token) DO NOTHING
          RETURNING token
          `,
          [
            entry.token,
            entry.target.action,
            entry.target.sessionId,
            entry.target.callId,
            entry.decisionGroupId,
            entry.expiresAt,
          ],
        );
        if (inserted.rows.length === 0) {
          await client.query('ROLLBACK');
          return false;
        }
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export async function claimTelegramAction(
  token: string,
  claimId: string,
  now: Date,
  leaseExpiresAt: Date,
): Promise<TelegramActionClaim> {
  await ensureTelegramActionStore();
  return withDbClient(async client => {
    await client.query('BEGIN');
    try {
      const groupLookup = await client.query<{ decision_group_id: string }>(
        'SELECT decision_group_id FROM telegram_action_tokens WHERE token = $1',
        [token],
      );
      const decisionGroupId = groupLookup.rows[0]?.decision_group_id;
      if (!decisionGroupId) {
        await client.query('COMMIT');
        return { status: 'invalid' };
      }

      const locked = await client.query<ActionRow>(
        `
        SELECT token, action, session_id, call_id, decision_group_id, status,
               claim_id, lease_expires_at, expires_at
        FROM telegram_action_tokens
        WHERE decision_group_id = $1
        ORDER BY token
        FOR UPDATE
        `,
        [decisionGroupId],
      );
      const target = locked.rows.find(row => row.token === token);
      if (!target || new Date(target.expires_at).getTime() <= now.getTime()) {
        await client.query('COMMIT');
        return { status: 'invalid' };
      }
      if (locked.rows.some(row => row.status === 'consumed')) {
        await client.query('COMMIT');
        return { status: 'consumed' };
      }
      if (locked.rows.some(row =>
        row.status === 'processing'
        && row.lease_expires_at !== null
        && new Date(row.lease_expires_at).getTime() > now.getTime())) {
        await client.query('COMMIT');
        return { status: 'processing' };
      }

      await client.query(
        `
        UPDATE telegram_action_tokens
        SET status = 'processing',
            claim_id = $2,
            lease_expires_at = $4,
            updated_at = $3
        WHERE decision_group_id = $1
        `,
        [decisionGroupId, claimId, now, leaseExpiresAt],
      );
      await client.query('COMMIT');
      return { status: 'claimed', decisionGroupId, target: targetFromRow(target) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export async function consumeTelegramAction(
  token: string,
  claimId: string,
  callbackId: string,
  userId: number,
  now: Date,
): Promise<boolean> {
  await ensureTelegramActionStore();
  return updateClaimedDecisionGroup(token, claimId, async (client, decisionGroupId) => {
    const result = await client.query<{ token: string }>(
      `
      UPDATE telegram_action_tokens
      SET status = 'consumed',
          consumed_callback_id = $3,
          consumed_user_id = $4,
          consumed_at = $5,
          lease_expires_at = NULL,
          updated_at = $5
      WHERE decision_group_id = $1
        AND status = 'processing'
        AND claim_id = $2
      RETURNING token
      `,
      [decisionGroupId, claimId, callbackId, userId, now],
    );
    return result.rows.some(row => row.token === token);
  });
}

export async function releaseTelegramAction(token: string, claimId: string, now: Date): Promise<void> {
  await ensureTelegramActionStore();
  await updateClaimedDecisionGroup(token, claimId, async (client, decisionGroupId) => {
    await client.query(
      `
      UPDATE telegram_action_tokens
      SET status = 'pending',
          claim_id = NULL,
          lease_expires_at = NULL,
          updated_at = $3
      WHERE decision_group_id = $1
        AND status = 'processing'
        AND claim_id = $2
      `,
      [decisionGroupId, claimId, now],
    );
  });
}

export async function deleteTelegramActionEntries(tokens: readonly string[]): Promise<void> {
  if (tokens.length === 0) return;
  await ensureTelegramActionStore();
  await getDb().query('DELETE FROM telegram_action_tokens WHERE token = ANY($1::text[])', [[...tokens]]);
}

function targetFromRow(row: ActionRow): TelegramActionTarget {
  if (row.action !== 'approve' && row.action !== 'deny' && row.action !== 'escalate') {
    throw new Error(`Invalid persisted Telegram action: ${row.action}`);
  }
  return { action: row.action, sessionId: row.session_id, callId: row.call_id };
}

async function updateClaimedDecisionGroup<T>(
  token: string,
  claimId: string,
  update: (
    client: Parameters<Parameters<typeof withDbClient>[0]>[0],
    decisionGroupId: string,
  ) => Promise<T>,
): Promise<T | false> {
  return withDbClient(async client => {
    await client.query('BEGIN');
    try {
      const groupLookup = await client.query<{ decision_group_id: string }>(
        'SELECT decision_group_id FROM telegram_action_tokens WHERE token = $1',
        [token],
      );
      const decisionGroupId = groupLookup.rows[0]?.decision_group_id;
      if (!decisionGroupId) {
        await client.query('COMMIT');
        return false;
      }
      const locked = await client.query<ActionRow>(
        `
        SELECT token, action, session_id, call_id, decision_group_id, status,
               claim_id, lease_expires_at, expires_at
        FROM telegram_action_tokens
        WHERE decision_group_id = $1
        ORDER BY token
        FOR UPDATE
        `,
        [decisionGroupId],
      );
      const target = locked.rows.find(row => row.token === token);
      if (!target || target.status !== 'processing' || target.claim_id !== claimId) {
        await client.query('COMMIT');
        return false;
      }
      const result = await update(client, decisionGroupId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
