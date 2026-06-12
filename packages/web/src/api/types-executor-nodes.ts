export type ExecutorNode = {
  nodeId: string;
  nodeKind: 'executor' | 'ssh_target' | 'ingress' | 'proxy';
  baseUrl?: string;
  hostLabel?: string;
  status: 'online' | 'draining' | 'offline';
  version?: string;
  targetVersion?: string;
  rolloutState?: 'idle' | 'draining' | 'upgrading' | 'verifying' | 'failed';
  rolloutMessage?: string;
  connectModes: string[];
  connectConfig: Record<string, unknown>;
  capacity: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  verified: Record<string, unknown>;
  queueDepth: number;
  activeTaskCount: number;
  meshLinks: Array<Record<string, unknown>>;
  lastProbeAt?: string;
  lastProbeError?: string;
  lastHeartbeatAt: string;
  createdAt: string;
  updatedAt: string;
  execution: {
    candidate: boolean;
    mode?: string;
    blockers: string[];
    warnings: string[];
  };
};

export type ExecutorNodeUpsertPayload = {
  nodeKind?: ExecutorNode['nodeKind'];
  baseUrl?: string;
  hostLabel?: string;
  status?: ExecutorNode['status'];
  version?: string;
  targetVersion?: string;
  rolloutState?: ExecutorNode['rolloutState'];
  rolloutMessage?: string;
  connectModes?: ExecutorNode['connectModes'] | string;
  connectConfig?: Record<string, unknown>;
  capacity?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  verified?: Record<string, unknown>;
  queueDepth?: number;
  activeTaskCount?: number;
  meshLinks?: Array<Record<string, unknown>>;
};

export type ExecutorNodeProbeResponse = {
  ok: boolean;
  node: ExecutorNode;
  probe: {
    status: ExecutorNode['status'];
    verified: Record<string, unknown>;
    lastProbeError?: string;
  };
};

