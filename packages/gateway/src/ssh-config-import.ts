import type { ExecutorNodeConnectMode, ExecutorNodeKind, ExecutorNodeStatus } from '@los/agent/executor-nodes';

export type SshImportAction = 'create' | 'update' | 'skip_no_match' | 'error';

export type SshImportNodeDraft = {
  nodeId: string;
  nodeKind: ExecutorNodeKind;
  status: ExecutorNodeStatus;
  hostLabel: string;
  connectModes: ExecutorNodeConnectMode[];
  connectConfig: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  capacity: Record<string, unknown>;
  meshLinks: Array<Record<string, unknown>>;
};

export type SshImportItem = {
  alias: string;
  hostName: string;
  user?: string;
  port: number;
  nodeId: string;
  matchedNodeId?: string;
  action: SshImportAction;
  willWrite: boolean;
  error?: string;
  node?: SshImportNodeDraft;
};

type SshHostEntry = {
  alias: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFile?: string;
};

export function buildSshImportItems(
  content: string,
  existingNodeIds: Set<string>,
  options: {
    dryRun: boolean;
    createMissing: boolean;
  },
): SshImportItem[] {
  return parseSshConfig(content).map((entry) => {
    try {
      const node = buildNodeDraft(entry);
      const exists = existingNodeIds.has(node.nodeId);
      const action: SshImportAction = exists ? 'update' : options.createMissing ? 'create' : 'skip_no_match';
      return {
        alias: entry.alias,
        hostName: entry.hostName,
        user: entry.user,
        port: nodePort(entry),
        nodeId: node.nodeId,
        matchedNodeId: exists ? node.nodeId : undefined,
        action,
        willWrite: !options.dryRun && (action === 'create' || action === 'update'),
        node: action === 'skip_no_match' ? undefined : node,
      };
    } catch (error) {
      return {
        alias: entry.alias,
        hostName: entry.hostName,
        port: nodePort(entry),
        nodeId: sanitizeNodeId(entry.alias),
        action: 'error',
        willWrite: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function parseSshConfig(content: string): SshHostEntry[] {
  const entries: SshHostEntry[] = [];
  let current: SshHostEntry[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const [keyRaw, ...rest] = splitSshLine(line);
    const key = keyRaw.toLowerCase();
    const value = rest.join(' ').trim();
    if (!key || !value) continue;

    if (key === 'host') {
      current = value
        .split(/\s+/)
        .map(alias => alias.trim())
        .filter(isConcreteHostAlias)
        .map(alias => ({ alias, hostName: '' }));
      entries.push(...current);
      continue;
    }

    if (current.length === 0) continue;
    for (const entry of current) {
      if (key === 'hostname') entry.hostName = value;
      if (key === 'user') entry.user = value;
      if (key === 'port') {
        const port = Number(value);
        if (Number.isFinite(port) && port > 0) entry.port = Math.floor(port);
      }
      if (key === 'identityfile') entry.identityFile = value;
    }
  }

  return entries
    .map(entry => ({
      ...entry,
      hostName: entry.hostName || entry.alias,
    }))
    .filter(entry => entry.alias && entry.hostName);
}

function buildNodeDraft(entry: SshHostEntry): SshImportNodeDraft {
  const nodeId = sanitizeNodeId(entry.alias);
  if (!nodeId) throw new Error('empty node id');

  const hostName = entry.hostName.trim();
  if (!hostName) throw new Error('empty HostName');

  const port = nodePort(entry);
  const endpoint = entry.user
    ? `${entry.user}@${hostName}:${port}`
    : `${hostName}:${port}`;

  return {
    nodeId,
    nodeKind: 'ssh_target',
    status: 'offline',
    hostLabel: entry.alias,
    connectModes: ['tailscale_ssh'],
    connectConfig: {
      ssh: {
        host_name: hostName,
        ...(entry.user ? { user: entry.user } : {}),
        port,
        ...(entry.identityFile ? { identity_file: entry.identityFile } : {}),
      },
      tailscale_ssh: {
        endpoint,
        source: 'ssh_config',
        alias: entry.alias,
      },
    },
    capabilities: {
      run_agent: false,
    },
    capacity: {},
    meshLinks: [],
  };
}

function nodePort(entry: SshHostEntry): number {
  return entry.port && entry.port > 0 ? entry.port : 22;
}

function sanitizeNodeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isConcreteHostAlias(alias: string): boolean {
  return Boolean(alias) && !alias.startsWith('!') && !/[?*]/.test(alias);
}

function splitSshLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | '' = '';
  for (const char of line) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = '';
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

function stripComment(line: string): string {
  let quote: '"' | "'" | '' = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = '';
      continue;
    }
    if (char === '#' && !quote) return line.slice(0, i);
  }
  return line;
}
