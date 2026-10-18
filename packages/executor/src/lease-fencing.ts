import { heartbeatAgentTask, heartbeatTaskRun, loadTaskRun } from '@los/agent';
import { createAbortError } from './executor-helpers.js';

/**
 * Transport for a single task-run lease renewal.
 *
 * When `http` is present the executor talks to the gateway with the short-lived
 * `x-los-task-token`; otherwise it keeps the legacy direct-DB path. A token
 * failure must never fall back to DB: that would turn 401/409 into a false
 * green (the exact failure mode C1 was written to prevent).
 */
export interface TaskLeaseHttpTransport {
  gatewayUrl: string;
  taskToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type TaskLeaseRenewal =
  | { ok: true; taskToken?: string }
  | {
      ok: false;
      reason:
        | 'token_invalid'
        | 'token_scope_mismatch'
        | 'lease_lost'
        | 'token_not_configured'
        | 'gateway_url_missing';
    };

export async function _renewTaskRunLease(
  taskRunId: string,
  nodeId: string,
  leaseVersion: number,
  leaseMs: number,
  http?: TaskLeaseHttpTransport,
): Promise<TaskLeaseRenewal> {
  if (!http) {
    const renewed = await heartbeatTaskRun(taskRunId, { nodeId, leaseVersion, leaseMs });
    return renewed ? { ok: true } : { ok: false, reason: 'lease_lost' };
  }
  if (!http.gatewayUrl) return { ok: false, reason: 'gateway_url_missing' };

  const fetchImpl = http.fetchImpl ?? fetch;
  const url = `${http.gatewayUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(taskRunId)}/heartbeat`;
  const timeoutMs = http.timeoutMs ?? 10_000;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-los-task-token': http.taskToken,
    },
    body: JSON.stringify({ leaseMs }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.ok) {
    let taskToken: string | undefined;
    try {
      const body = await res.json() as { taskToken?: unknown };
      if (typeof body.taskToken === 'string' && body.taskToken) taskToken = body.taskToken;
    } catch {
      // A 200 without a JSON body is still a valid lease renewal.
    }
    return { ok: true, ...(taskToken ? { taskToken } : {}) };
  }
  if (res.status === 401) return { ok: false, reason: 'token_invalid' };
  if (res.status === 403) return { ok: false, reason: 'token_scope_mismatch' };
  if (res.status === 409) return { ok: false, reason: 'lease_lost' };
  if (res.status === 503) return { ok: false, reason: 'token_not_configured' };
  throw new Error(`task lease heartbeat failed with ${res.status}`);
}

export async function _renewTaskLease(
  taskRunId: string,
  nodeId: string,
  leaseVersion: number,
  agentTaskLease: { taskId: string; leaseVersion: number } | undefined,
  leaseMs: number,
  controller: AbortController,
  http?: TaskLeaseHttpTransport,
): Promise<void> {
  const [taskRunRenewal, renewedAgentTask] = await Promise.all([
    _renewTaskRunLease(taskRunId, nodeId, leaseVersion, leaseMs, http),
    agentTaskLease
      ? heartbeatAgentTask(agentTaskLease.taskId, {
          nodeId,
          leaseVersion: agentTaskLease.leaseVersion,
          leaseMs,
        })
      : Promise.resolve(true),
  ]);

  if (taskRunRenewal.ok && taskRunRenewal.taskToken && http) {
    http.taskToken = taskRunRenewal.taskToken;
  }

  if (!taskRunRenewal.ok) {
    if (controller.signal.aborted) return;
    // The HTTP path must not consult the DB to explain the failure: a remote
    // executor in the stateless phase has no DATABASE_URL.
    if (http) {
      controller.abort(createAbortError(taskRunRenewal.reason));
      return;
    }
    const taskRun = await loadTaskRun(taskRunId).catch(() => null);
    controller.abort(createAbortError(
      taskRun?.status === 'cancelled' ? 'cancelled_by_scheduler' : taskRunRenewal.reason,
    ));
    return;
  }

  if (!renewedAgentTask && !controller.signal.aborted) {
    controller.abort(createAbortError('lease_lost'));
  }
}
