#!/usr/bin/env tsx

import { loadConfig } from '../packages/infra/src/config.ts';
import { closeDb, getDb, initDb } from '../packages/infra/src/db.ts';
import { resolveNamedFleetNodeIds } from '../packages/agent/src/fleet-inventory.ts';
import {
  deleteNodeMaintenancePolicy,
  isNodeInMaintenance,
  loadNodeMaintenancePolicy,
  upsertNodeMaintenancePolicy,
} from '../packages/agent/src/node-maintenance-policy.ts';
import {
  appendMaintenanceWindow,
  maintenanceWindowId,
  parseDurationMs,
  pruneExpiredMaintenanceWindows,
  removeMaintenanceWindow,
} from './fleet-maintenance-window.mjs';

interface ActiveTaskRow {
  node_id: string;
  active_task_count: number;
}

const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';
const operator = process.env.USER;

function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm fleet:maintenance status
  pnpm fleet:maintenance start --for 8h [--force-active]
  pnpm fleet:maintenance clear <window-id>
  pnpm fleet:maintenance prune

The start command appends one common absolute window to every named fleet node.
It refuses to start while executor tasks are active unless --force-active is set.`);
}

async function activeTasks(): Promise<ActiveTaskRow[]> {
  const rows = await getDb().query<ActiveTaskRow>(
    `SELECT node_id, active_task_count
       FROM executor_nodes
      WHERE node_kind = 'executor' AND active_task_count > 0
      ORDER BY node_id`,
  );
  return rows.rows;
}

async function showStatus(nodeIds: string[], now: Date): Promise<void> {
  const nodes = [];
  for (const nodeId of nodeIds) {
    const policy = await loadNodeMaintenancePolicy(nodeId);
    nodes.push({
      nodeId,
      active: isNodeInMaintenance(nodeId, now, policy),
      windows: (policy?.windows ?? []).map((window) => ({
        id: maintenanceWindowId(window),
        ...window,
      })),
    });
  }
  console.log(JSON.stringify({ now: now.toISOString(), nodes }, null, 2));
}

async function main(): Promise<void> {
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const nodeIds = resolveNamedFleetNodeIds();
  const now = new Date();

  try {
    if (command === 'status') {
      await showStatus(nodeIds, now);
      return;
    }

    if (command === 'start') {
      const durationRaw = argValue('--for');
      if (!durationRaw) throw new Error('start requires --for <duration>');
      const active = await activeTasks();
      if (active.length > 0 && !argv.includes('--force-active')) {
        console.error(JSON.stringify({ error: 'active executor tasks', active }, null, 2));
        process.exitCode = 2;
        return;
      }
      const durationMs = parseDurationMs(durationRaw);
      const window = {
        start: now.toISOString(),
        end: new Date(now.getTime() + durationMs).toISOString(),
      };
      for (const nodeId of nodeIds) {
        const policy = await loadNodeMaintenancePolicy(nodeId);
        await upsertNodeMaintenancePolicy(
          nodeId,
          { windows: appendMaintenanceWindow(policy?.windows ?? [], window, now.getTime()) },
          { source: 'cli:fleet-maintenance', operator },
        );
      }
      console.log(JSON.stringify({
        action: 'started',
        window: { id: maintenanceWindowId(window), ...window },
        nodeIds,
        forcedWithActiveTasks: active.length > 0,
      }, null, 2));
      return;
    }

    if (command === 'clear') {
      const windowId = argv[1];
      if (!windowId) throw new Error('clear requires <window-id>');
      const changed = [];
      for (const nodeId of nodeIds) {
        const policy = await loadNodeMaintenancePolicy(nodeId);
        const result = removeMaintenanceWindow(policy?.windows ?? [], windowId);
        if (!result.removed) continue;
        if (result.windows.length > 0) {
          await upsertNodeMaintenancePolicy(
            nodeId,
            { windows: result.windows },
            { source: 'cli:fleet-maintenance', operator },
          );
        } else {
          await deleteNodeMaintenancePolicy(nodeId, {
            source: 'cli:fleet-maintenance',
            operator,
          });
        }
        changed.push(nodeId);
      }
      console.log(JSON.stringify({ action: 'cleared', windowId, changed }, null, 2));
      if (changed.length === 0) process.exitCode = 1;
      return;
    }

    if (command === 'prune') {
      const changed = [];
      for (const nodeId of nodeIds) {
        const policy = await loadNodeMaintenancePolicy(nodeId);
        if (!policy) continue;
        const windows = pruneExpiredMaintenanceWindows(policy.windows, now.getTime());
        if (windows.length === policy.windows.length) continue;
        if (windows.length > 0) {
          await upsertNodeMaintenancePolicy(
            nodeId,
            { windows },
            { source: 'cli:fleet-maintenance', operator },
          );
        } else {
          await deleteNodeMaintenancePolicy(nodeId, {
            source: 'cli:fleet-maintenance',
            operator,
          });
        }
        changed.push(nodeId);
      }
      console.log(JSON.stringify({ action: 'pruned', changed }, null, 2));
      return;
    }

    throw new Error(`unknown command: ${command}`);
  } finally {
    await closeDb().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
