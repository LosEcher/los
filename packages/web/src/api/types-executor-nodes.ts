export type ExecutorNodeResourceClass = 'control' | 'standard_executor' | 'constrained_executor';

export type ExecutorNode = {
  nodeId: string;
  nodeKind: 'executor' | 'ssh_target' | 'ingress' | 'proxy';
  resourceClass?: ExecutorNodeResourceClass;
  baseUrl?: string;
  hostLabel?: string;
  status: 'online' | 'draining' | 'offline';
  version?: string;
  targetVersion?: string;
  rolloutState?: 'idle' | 'draining' | 'upgrading' | 'verifying' | 'failed';
  rolloutMessage?: string;
  connectModes: string[];
  connectConfig: Record<string, unknown>;
  capacity: {
    pid?: number;
    arch?: string;
    platform?: string;
    memoryTotalMb?: number;
    memoryAvailableMb?: number;
    swapTotalMb?: number;
    swapUsedMb?: number;
    diskFreeGb?: number;
    psiMemorySome?: number;
    psiMemoryFull?: number;
    psiIoSome?: number;
    psiIoFull?: number;
  } & Record<string, unknown>;
  capabilities: {
    run_agent?: boolean;
    stream_ndjson?: boolean;
    task_lease?: boolean;
    workspace_read?: boolean;
    workspace_write?: boolean;
    shell?: boolean;
    sandbox?: string;
    deploy_safe?: boolean;
    heavy_task_safe?: boolean;
  } & Record<string, unknown>;
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

