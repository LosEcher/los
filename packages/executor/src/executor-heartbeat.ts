import { hostname } from 'node:os';
import type { ExecutorNodeConnectMode, ExecutorNodeKind } from '@los/agent';
import { getAvailableSandbox } from '@los/agent';
import { collectResourceMetrics, resolveResourceCapabilities } from './resource-metrics.js';
import type { ExecutorRuntimeLifecycle } from './runtime-lifecycle.js';

/**
 * Resolve the sandbox capability value reported in the node heartbeat.
 * Returns a concrete OS backend name when one is installed (linux-bwrap /
 * macos-sandbox-exec); otherwise keeps the legacy `tool_policy` marker.
 */
function detectSandboxBackend(): string {
  const backend = getAvailableSandbox();
  return backend === 'native' ? 'tool_policy' : backend;
}

/** Where a node's reported version came from — same vocabulary as the gateway. */
export type NodeVersionSource = 'env' | 'package_json' | 'unversioned';

export type NodeVersionIdentity = { version: string; versionSource: NodeVersionSource };

function normalizeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the node's content identity once, at start-up.
 *
 * `config.executor.version` and `config.server.version` both come from
 * `LOS_VERSION`/`EXECUTOR_VERSION` in the launcher, so either one counts as
 * `env`. Falling back to the package version is **not** a content hash and is
 * labelled `package_json` so the daily report can count `unpinned` nodes
 * instead of mislabelling them as drift
 * (docs/architecture/2026-10-10-control-plane-truth-remediation.md §1).
 */
export function resolveNodeVersion(inputs: {
  executorVersion?: string;
  serverVersion?: string;
  packageVersion?: string;
}): NodeVersionIdentity {
  const envVersion = normalizeVersion(inputs.executorVersion) ?? normalizeVersion(inputs.serverVersion);
  if (envVersion) return { version: envVersion, versionSource: 'env' };
  const packageVersion = normalizeVersion(inputs.packageVersion);
  if (packageVersion) return { version: packageVersion, versionSource: 'package_json' };
  return { version: 'unknown', versionSource: 'unversioned' };
}

export interface HeartbeatResponse {
  credentialExpiresAt?: string;
  credentialRotationDue?: boolean;
}

export async function heartbeatNode(
  nodeId: string,
  baseUrl: string,
  version: string,
  nodeKind: ExecutorNodeKind,
  connectModes: ExecutorNodeConnectMode[],
  lifecycle: ExecutorRuntimeLifecycle,
  gatewayUrl?: string,
  fileSyncFolders?: Array<{ name: string; localPath: string; mode?: string }>,
  agentKey?: string,
  /**
   * Per-node credential from `POST /nodes/enroll`, sent as
   * `x-los-node-credential` so the gateway can attribute this heartbeat to a
   * specific node instead of the shared `agentKey` (ADR 0048 B3, send side first).
   * Optional during the transition: the gateway verifies it when present and still
   * accepts heartbeats without it.
   */
  nodeCredential?: string,
  /**
   * Provenance of `version`. Registered in the existing `capabilities` JSON —
   * deliberately **not** a new column, so the node row needs no migration and
   * "no `+b`" can be counted as `unpinned` rather than as drift.
   */
  versionSource: NodeVersionSource = 'unversioned',
): Promise<HeartbeatResponse> {
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
    // Provenance of the `version` field above. `package_json` means this node is
    // running an unpinned build, not that it drifts from its declared target.
    versionSource,
    // Report the real OS isolation backend when one exists. `tool_policy` (the
    // legacy default) and `native` intentionally do NOT satisfy a sandbox
    // requirement — only a concrete backend (linux-bwrap / macos-sandbox-exec)
    // unlocks sandboxMode='sandbox' execution on this node.
    sandbox: detectSandboxBackend(),
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
      headers: {
        'content-type': 'application/json',
        ...(agentKey ? { authorization: `Bearer ${agentKey}` } : {}),
        ...(nodeCredential ? { 'x-los-node-credential': nodeCredential } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`gateway heartbeat returned ${res.status}: ${await res.text()}`);
    }
    // 响应带凭据到期信息（rotation due 时 executor 自助换钥）。空 body / 旧网关
    // 不得让心跳失败：解析失败就当作没有附加信息。
    try {
      return (await res.json()) as HeartbeatResponse;
    } catch {
      return {};
    }
  } else {
    const { upsertExecutorNodeHeartbeat } = await import('@los/agent');
    await upsertExecutorNodeHeartbeat(payload);
    return {};
  }
}
