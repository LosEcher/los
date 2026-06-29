import type { ChatPayload, RuntimePayload, StreamEvent } from './types.js';

export class AuthError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function checkResponse(res: Response): void {
  if (!res.ok) {
    const err = res.status === 401
      ? new AuthError('Authentication required — set auth token in Settings', res.status)
      : new Error(`${res.status} ${res.statusText}`);
    throw err;
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const headers = buildHeaders();
  const res = await fetch(path, { headers });
  checkResponse(res);
  return await res.json() as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const headers = buildHeaders();
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  checkResponse(res);
  return await res.json() as T;
}

export async function deleteJson<T>(path: string): Promise<T> {
  const headers = buildHeaders();
  const res = await fetch(path, { method: 'DELETE', headers });
  checkResponse(res);
  return await res.json() as T;
}

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const headers = buildHeaders();
  const res = await fetch(path, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  checkResponse(res);
  return await res.json() as T;
}

export async function streamChat(
  payload: ChatPayload,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const headers = buildHeaders();
  const res = await fetch('/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    checkResponse(res);
    throw new Error(`${res.status} ${res.statusText}`);
  }

  await readSSEStream(res.body, onEvent);
}

export async function streamRuntime(
  payload: RuntimePayload,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const headers = buildHeaders();
  const res = await fetch(`/runtimes/${payload.kind}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    checkResponse(res);
    throw new Error(`${res.status} ${res.statusText}`);
  }

  await readSSEStream(res.body, onEvent);
}

async function readSSEStream(body: ReadableStream<Uint8Array>, onEvent: (event: StreamEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventName = line.slice(7).trim();
        continue;
      }
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        onEvent({ event: eventName, data });
        eventName = 'message';
      }
    }
  }
}

// ── Shared header builder ────────────────────────────

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const pid = getCurrentProjectId();
  if (pid) headers['x-project-id'] = pid;
  const token = getAuthToken();
  if (token) headers['x-los-auth-token'] = token;
  // Tenant and user are required by request-context when auth is enabled.
  // Web always identifies as 'local' (single-tenant, single-user UI).
  headers['x-tenant-id'] = 'local';
  headers['x-user-id'] = 'local';
  return headers;
}

// ── Current project header ───────────────────────────

const PROJECT_ID_KEY = 'los-project-id';

export function getCurrentProjectId(): string | undefined {
  try {
    const val = localStorage.getItem(PROJECT_ID_KEY);
    return val?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function setCurrentProjectId(projectId: string | undefined): void {
  try {
    if (projectId) {
      localStorage.setItem(PROJECT_ID_KEY, projectId);
    } else {
      localStorage.removeItem(PROJECT_ID_KEY);
    }
  } catch { /* ignore */ }
}

// ── Auth token ───────────────────────────────────────

const AUTH_TOKEN_KEY = 'los-auth-token';

export function getAuthToken(): string | undefined {
  try {
    const val = localStorage.getItem(AUTH_TOKEN_KEY);
    return val?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function setAuthToken(token: string | undefined): void {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch { /* ignore */ }
}
