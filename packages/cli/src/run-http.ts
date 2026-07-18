type JsonRecord = Record<string, unknown>;

export interface RunRequestAuth {
  authToken?: string;
  operatorToken?: string;
}

export async function getRunJson(url: string, auth: RunRequestAuth): Promise<unknown> {
  return await requestRunJson(url, {
    headers: authHeaders(auth, false),
  });
}

export async function postRunJson(
  url: string,
  body: JsonRecord,
  auth: RunRequestAuth,
): Promise<unknown> {
  return await requestRunJson(url, {
    method: 'POST',
    headers: authHeaders(auth, true),
    body: JSON.stringify(body),
  });
}

function authHeaders(auth: RunRequestAuth, operatorWrite: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth.authToken) headers['x-los-auth-token'] = auth.authToken;
  if (operatorWrite && auth.operatorToken) headers['x-los-operator-token'] = auth.operatorToken;
  if (operatorWrite) headers['Content-Type'] = 'application/json';
  return headers;
}

async function requestRunJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json() as unknown;
}
