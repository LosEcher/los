import { hostname } from 'node:os';
import type { ExecutorNodeConnectMode, ExecutorNodeKind } from '@los/agent';
import { collectResourceMetrics, resolveResourceCapabilities } from './resource-metrics.js';
import type { ExecutorRuntimeLifecycle } from './runtime-lifecycle.js';

export async function heartbeatNode(
  nodeId: string,
  baseUrl: string,
  version: string,
  nodeKind: ExecutorNodeKind,
  connectModes: ExecutorNodeConnectMode[],
  lifecycle: ExecutorRuntimeLifecycle,
  gatewayUrl?: string,
  fileSyncFolders?: Array<{ name: string; localPath: string; mode?: string }>,
): Promise<void> {
  const capabilities: Record<string, unknown> = {
    run_agent: lifecycle.acceptingTasks,
    stream_ndjson: true,
    task_lease: true,
    workspace_read: true,
    workspace_write: true,
    artifact_transfer: true,
    node_command_runner: true,
    file_sync_scan: true,
    file_sync_deep_verify: true,
    shell: true,
    sandbox: 'tool_policy',
    ...resolveResourceCapabilities(),
  };
  if (fileSyncFolders && fileSyncFolders.length > 0) {
    capabilities.file_sync_folders = fileSyncFolders.map(f => ({
      name: f.name,
      folder: f.name,
      path: f.localPath,
      mode: f.mode ?? 'incremental',
    }));
  }

  const payload = {
    nodeId,
    baseUrl,
    hostLabel: hostname(),
    version,
    nodeKind,
    connectModes,
    connectConfig: {
      agent_http: {
        baseUrl,
        runAgentUrl: `${baseUrl}/v1/tasks/run-agent`,
        healthUrl: `${baseUrl}/health`,
        artifactsUrl: `${baseUrl}/v1/artifacts`,
        commandUrl: `${baseUrl}/v1/nodes/${nodeId}/commands`,
      },
    },
    capacity: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      ...collectResourceMetrics(),
    },
    capabilities,
    queueDepth: 0,
    activeTaskCount: lifecycle.activeTaskCount,
    status: lifecycle.status === 'online' ? undefined : lifecycle.status,
  };

  if (gatewayUrl) {
    const res = await fetch(`${gatewayUrl}/nodes/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`gateway heartbeat returned ${res.status}: ${await res.text()}`);
    }
  } else {
    const { upsertExecutorNodeHeartbeat } = await import('@los/agent');
    await upsertExecutorNodeHeartbeat(payload);
  }
}
