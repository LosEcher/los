/**
 * Executor 侧的节点凭据状态（轮换 + 落盘）。
 *
 * 为什么需要落盘：网关只把新凭据返回给**这一次** HTTP 响应；executor 如果只放内存，
 * 进程重启后就退回 `.env` 里的旧值，而旧值此时已进入 24h 重叠窗口的尾部 —— 30 天
 * TTL 会变成"每次重启都埋一颗定时炸弹"。状态文件放在 `.los-runtime/executor/`
 * （已被 .gitignore 排除），目录 0700、文件 0600，且只存凭据本身，不写日志。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface PersistedNodeCredential {
  nodeId: string;
  credential: string;
  expiresAt?: string;
}

export interface CredentialStoreOptions {
  /** Absolute path override (tests). Defaults to cwd/.los-runtime/executor/node-credential-<nodeId>.json. */
  path?: string;
  /** Working directory used for the default path. */
  cwd?: string;
}

export function _defaultCredentialStatePath(
  nodeId: string,
  cwd = process.cwd(),
): string {
  return resolve(cwd, '.los-runtime', 'executor', `node-credential-${encodeURIComponent(nodeId)}.json`);
}

function statePath(nodeId: string, options: CredentialStoreOptions): string {
  return options.path ?? _defaultCredentialStatePath(nodeId, options.cwd);
}

/** 读取状态文件；损坏/节点不匹配/缺字段都按"没有"处理，调用方回退到配置值。 */
export function _readPersistedNodeCredential(
  nodeId: string,
  options: CredentialStoreOptions = {},
): PersistedNodeCredential | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath(nodeId, options), 'utf8')) as Partial<PersistedNodeCredential>;
    if (parsed?.nodeId !== nodeId || typeof parsed.credential !== 'string' || !parsed.credential) return null;
    return {
      nodeId,
      credential: parsed.credential,
      ...(typeof parsed.expiresAt === 'string' ? { expiresAt: parsed.expiresAt } : {}),
    };
  } catch {
    return null;
  }
}

/** 启动时的有效凭据：状态文件优先（轮换过），否则用配置值。 */
export function loadNodeCredential(
  nodeId: string,
  fallback: string | undefined,
  options: CredentialStoreOptions = {},
): string | undefined {
  return _readPersistedNodeCredential(nodeId, options)?.credential ?? fallback;
}

/** 原子写：同目录临时文件 + rename，避免半截 JSON 让下次启动读不到凭据。 */
export function saveNodeCredential(
  nodeId: string,
  credential: string,
  expiresAt?: string,
  options: CredentialStoreOptions = {},
): void {
  const path = statePath(nodeId, options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const body: PersistedNodeCredential = {
    nodeId,
    credential,
    ...(expiresAt ? { expiresAt } : {}),
  };
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export interface RotateViaGatewayInput extends CredentialStoreOptions {
  gatewayUrl: string;
  nodeId: string;
  credential: string;
  /** Injection point for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RotatedNodeCredential extends PersistedNodeCredential {
  /** false ⇒ 内存已切换但落盘失败；调用方应尽快重试 saveNodeCredential。 */
  persisted: boolean;
}

/**
 * 调网关 `/nodes/credential/rotate`，成功则落盘并返回新凭据。
 * 网络/HTTP 失败返回 null（不抛）：心跳循环不能因为轮换失败而停摆，旧值还有重叠窗口。
 */
export async function rotateNodeCredentialViaGateway(
  input: RotateViaGatewayInput,
): Promise<RotatedNodeCredential | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${input.gatewayUrl.replace(/\/$/, '')}/nodes/credential/rotate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-los-node-credential': input.credential,
      },
      body: '{}',
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: Partial<PersistedNodeCredential>;
  try {
    body = (await res.json()) as Partial<PersistedNodeCredential>;
  } catch {
    return null;
  }
  if (body?.nodeId !== input.nodeId || typeof body.credential !== 'string' || !body.credential) {
    return null;
  }
  const rotated: RotatedNodeCredential = {
    nodeId: input.nodeId,
    credential: body.credential,
    ...(typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}),
    persisted: true,
  };
  try {
    saveNodeCredential(input.nodeId, rotated.credential, rotated.expiresAt, input);
  } catch {
    // 内存里必须切换到新值（否则旧值 24h 后失效）；落盘失败由调用方重试。
    rotated.persisted = false;
  }
  return rotated;
}
