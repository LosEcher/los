import type { ChatPayload, StreamEvent } from './types.js';

export async function getJson<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const pid = getCurrentProjectId();
  if (pid) headers['x-project-id'] = pid;
  const res = await fetch(path, { headers });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return await res.json() as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const pid = getCurrentProjectId();
  if (pid) headers['x-project-id'] = pid;
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return await res.json() as T;
}

export async function deleteJson<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const pid = getCurrentProjectId();
  if (pid) headers['x-project-id'] = pid;
  const res = await fetch(path, { method: 'DELETE', headers });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return await res.json() as T;
}

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const pid = getCurrentProjectId();
  if (pid) headers['x-project-id'] = pid;
  const res = await fetch(path, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return await res.json() as T;
}

export async function streamChat(
  payload: ChatPayload,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const pid = getCurrentProjectId();
  if (pid) headers['x-project-id'] = pid;
  const res = await fetch('/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
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
