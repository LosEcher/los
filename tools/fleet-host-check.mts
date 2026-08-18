#!/usr/bin/env tsx
/**
 * Manual fleet host check + recovery config management (P2 / P1' / config).
 *
 * Repair gate precedence: per-node policy > global DB config > env > default.
 * The check command resolves this chain internally; no env flags needed.
 *
 * Usage (repo root):
 *   ./packages/gateway/node_modules/.bin/tsx tools/fleet-host-check.mts
 *   ./packages/gateway/node_modules/.bin/tsx tools/fleet-host-check.mts --force
 *   ./packages/gateway/node_modules/.bin/tsx tools/fleet-host-check.mts --dry-run
 *
 * Global config (fleet_repair_config, survives restarts, no .env edit):
 *   ... --config-get
 *   ... --config-set autoRepair=true,cooldownMs=600000,restartUnhealthy=false
 *   ... --config-clear
 *
 * Fleet alert gates (fleet_alert_config):
 *   ... --alert-get
 *   ... --alert-set consecutiveTicks=3,cooldownMs=1800000
 *   ... --alert-clear
 *
 * Per-node policy (node_recovery_policy):
 *   ... --policy-get <nodeId>
 *   ... --policy-set <nodeId> repairEnabled=true,cooldownMs=600000,restartUnhealthy=false
 *   ... --policy-delete <nodeId>
 */
import { loadConfig } from '../packages/infra/src/config.ts';
import { closeDb, initDb } from '../packages/infra/src/db.ts';
import { runFleetHostChecks } from '../packages/agent/src/fleet-host-checks.ts';
import {
  clearFleetRepairConfig,
  loadFleetRepairConfig,
  upsertFleetRepairConfig,
  type RepairGateFields,
} from '../packages/agent/src/fleet-repair-config.ts';
import {
  clearFleetAlertConfig,
  loadFleetAlertConfig,
  upsertFleetAlertConfig,
  type FleetAlertConfigPatch,
} from '../packages/agent/src/fleet-alert-config.ts';
import {
  deleteNodeRecoveryPolicy,
  loadNodeRecoveryPolicy,
  upsertNodeRecoveryPolicy,
  type NodeRecoveryPolicyPatch,
} from '../packages/agent/src/node-recovery-policy.ts';

const argv = process.argv.slice(2);
const args = new Set(argv);
const force = args.has('--force') || args.has('-f');
const dryRun = args.has('--dry-run') || args.has('--dry');

function argValue(flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

/** Parse `key=value,key2=value2` into a typed gate-field patch. */
function parseGateFields<T extends Record<string, unknown>>(
  kvRaw: string,
): T {
  const patch: Record<string, unknown> = {};
  for (const kv of kvRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const key = kv.slice(0, eq).trim();
    const raw = kv.slice(eq + 1).trim();
    if (key === 'autoRepair' || key === 'repairEnabled' || key === 'restartUnhealthy') {
      patch[key] = raw.toLowerCase() === 'true' || raw === '1';
    } else if (key === 'cooldownMs' || key === 'maxConsecutiveFailures' || key === 'quorumThreshold') {
      const num = Number(raw);
      if (Number.isFinite(num)) patch[key] = num;
    } else if (key === 'supervisor') {
      patch[key] = raw;
    }
  }
  return patch as T;
}

const config = await loadConfig();
await initDb(config.databaseUrl);
try {
  const configGet = args.has('--config-get');
  const configSet = argValue('--config-set');
  const configClear = args.has('--config-clear');
  const alertGet = args.has('--alert-get');
  const alertSet = argValue('--alert-set');
  const alertClear = args.has('--alert-clear');
  const policyGet = argValue('--policy-get');
  const policySet = argValue('--policy-set');
  const policyDelete = argValue('--policy-delete');

  if (configGet) {
    const c = await loadFleetRepairConfig();
    console.log(JSON.stringify(c ?? { global: null }, null, 2));
    process.exitCode = c ? 0 : 1;
  } else if (configClear) {
    const removed = await clearFleetRepairConfig({ source: 'cli', operator: process.env.USER });
    console.log(JSON.stringify({ removed }, null, 2));
  } else if (configSet) {
    try {
      const saved = await upsertFleetRepairConfig(
        parseGateFields<RepairGateFields>(configSet),
        { source: 'cli', operator: process.env.USER },
      );
      console.log(JSON.stringify(saved, null, 2));
    } catch (err) {
      console.error(`config rejected: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    }
  } else if (alertGet) {
    const a = await loadFleetAlertConfig();
    console.log(JSON.stringify(a ?? { alert: null }, null, 2));
    process.exitCode = a ? 0 : 1;
  } else if (alertClear) {
    const removed = await clearFleetAlertConfig({ source: 'cli', operator: process.env.USER });
    console.log(JSON.stringify({ removed }, null, 2));
  } else if (alertSet) {
    try {
      const saved = await upsertFleetAlertConfig(
        parseGateFields<FleetAlertConfigPatch>(alertSet),
        { source: 'cli', operator: process.env.USER },
      );
      console.log(JSON.stringify(saved, null, 2));
    } catch (err) {
      console.error(`alert config rejected: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    }
  } else if (policyGet) {
    const p = await loadNodeRecoveryPolicy(policyGet);
    console.log(JSON.stringify(p ?? { nodeId: policyGet, policy: null }, null, 2));
    process.exitCode = p ? 0 : 1;
  } else if (policyDelete) {
    const removed = await deleteNodeRecoveryPolicy(policyDelete, {
      source: 'cli',
      operator: process.env.USER,
    });
    console.log(JSON.stringify({ nodeId: policyDelete, removed }, null, 2));
  } else if (policySet) {
    const eq = policySet.indexOf('=');
    const nodeId = eq > 0 ? policySet.slice(0, eq).trim() : '';
    try {
      const saved = await upsertNodeRecoveryPolicy(
        nodeId ?? '',
        parseGateFields<NodeRecoveryPolicyPatch>(eq > 0 ? policySet.slice(eq + 1) : ''),
        { source: 'cli', operator: process.env.USER },
      );
      console.log(JSON.stringify(saved, null, 2));
    } catch (err) {
      console.error(`policy rejected: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    }
  } else {
    const report = await runFleetHostChecks({ force, dryRun, quiet: dryRun });
    console.log(JSON.stringify(report, null, 2));
    if (report.failed.length > 0) process.exitCode = 2;
    else if (report.degraded.length > 0) process.exitCode = 1;
  }
} finally {
  await closeDb().catch(() => undefined);
}
