/**
 * Fleet alert gates (P1 config promotion) — same pattern as fleet-repair-config:
 * Zod schema + singleton DB row + ops.config_changed audit + resolve chain
 * (DB > env > default), so operator-tuned alert thresholds survive restarts
 * and change at runtime without editing .env.
 */

import { z } from '@los/infra/zod';
import { getDb } from '@los/infra/db';
import {
  auditConfigChange,
  type ConfigChangeMeta,
} from './fleet-repair-config.js';

export const DEFAULT_FLEET_ALERT_CONSECUTIVE_TICKS = 2;
export const DEFAULT_FLEET_ALERT_COOLDOWN_MS = 30 * 60_000;

export const fleetAlertConfigSchema = z.object({
  consecutiveTicks: z.number().int().min(1).nullish(),
  cooldownMs: z.number().int().min(0).nullish(),
});
export type FleetAlertConfigPatch = z.infer<typeof fleetAlertConfigSchema>;

export interface FleetAlertConfig {
  consecutiveTicks: number | null;
  cooldownMs: number | null;
  updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_alert_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consecutive_ticks INTEGER,
  cooldown_ms INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let _initialized = false;

export async function ensureFleetAlertConfigStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

export function _resetFleetAlertConfigStoreForTests(): void {
  _initialized = false;
}

interface AlertConfigRow {
  id: number;
  consecutive_ticks: number | null;
  cooldown_ms: number | null;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToConfig(row: AlertConfigRow): FleetAlertConfig {
  return {
    consecutiveTicks: row.consecutive_ticks,
    cooldownMs: row.cooldown_ms,
    updatedAt: toIso(row.updated_at),
  };
}

export async function loadFleetAlertConfig(): Promise<FleetAlertConfig | null> {
  await ensureFleetAlertConfigStore();
  const db = getDb();
  const rows = await db.query<AlertConfigRow>('SELECT * FROM fleet_alert_config WHERE id = 1');
  return rows.rows[0] ? rowToConfig(rows.rows[0]) : null;
}

export async function upsertFleetAlertConfig(
  patch: FleetAlertConfigPatch,
  meta: ConfigChangeMeta = {},
): Promise<FleetAlertConfig> {
  const parsed = fleetAlertConfigSchema.parse(patch); // throws on invalid input
  await ensureFleetAlertConfigStore();
  const before = await loadFleetAlertConfig();
  const db = getDb();
  const rows = await db.query<AlertConfigRow>(
    `INSERT INTO fleet_alert_config
       (id, consecutive_ticks, cooldown_ms, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET
       consecutive_ticks = COALESCE(EXCLUDED.consecutive_ticks, fleet_alert_config.consecutive_ticks),
       cooldown_ms = COALESCE(EXCLUDED.cooldown_ms, fleet_alert_config.cooldown_ms),
       updated_at = now()
     RETURNING *`,
    [
      parsed.consecutiveTicks === undefined ? null : parsed.consecutiveTicks,
      parsed.cooldownMs === undefined ? null : parsed.cooldownMs,
    ],
  );
  const after = rowToConfig(assertRow(rows.rows[0]));
  await auditConfigChange({
    scope: 'fleet_alert_config',
    fields: Object.keys(parsed),
    before: before ? { ...before } : null,
    after: { ...after },
    ...meta,
  }).catch(() => undefined);
  return after;
}

export async function clearFleetAlertConfig(meta: ConfigChangeMeta = {}): Promise<boolean> {
  await ensureFleetAlertConfigStore();
  const before = await loadFleetAlertConfig();
  const db = getDb();
  const rows = await db.query('DELETE FROM fleet_alert_config WHERE id = 1 RETURNING id');
  const removed = rows.rows.length > 0;
  if (removed) {
    await auditConfigChange({
      scope: 'fleet_alert_config',
      fields: ['*'],
      before: before ? { ...before } : null,
      after: null,
      ...meta,
    }).catch(() => undefined);
  }
  return removed;
}

export interface ResolvedFleetAlertConfig {
  consecutiveTicks: number;
  cooldownMs: number;
}

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Merge alert gate source chain: DB row > env (LOS_FLEET_ALERT_*) > defaults.
 * Invalid env values are ignored (fall back to default), matching the legacy
 * fleet-inventory resolvers.
 */
export async function resolveFleetAlertConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: ResolvedFleetAlertConfig,
): Promise<ResolvedFleetAlertConfig> {
  const db = await loadFleetAlertConfig().catch(() => null);
  const ticksRaw = envNumber(env.LOS_FLEET_ALERT_CONSECUTIVE_TICKS);
  const cooldownRaw = envNumber(env.LOS_FLEET_ALERT_COOLDOWN_MS);
  const consecutiveTicks = db?.consecutiveTicks
    ?? (ticksRaw !== undefined && ticksRaw >= 1 ? Math.floor(ticksRaw) : undefined)
    ?? defaults.consecutiveTicks;
  const cooldownMs = db?.cooldownMs
    ?? (cooldownRaw !== undefined && cooldownRaw >= 0 ? Math.floor(cooldownRaw) : undefined)
    ?? defaults.cooldownMs;
  return { consecutiveTicks, cooldownMs };
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('fleet_alert_config write failed');
  return row;
}
