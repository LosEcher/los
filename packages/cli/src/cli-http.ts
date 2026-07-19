export interface CliRequestAuth {
  authToken?: string;
  operatorToken?: string;
}

export interface CliRequestOptions extends RequestInit {
  auth?: CliRequestAuth;
  operatorWrite?: boolean;
  json?: boolean;
}

export function resolveCliRequestAuth(flags: Record<string, unknown>): CliRequestAuth {
  return {
    authToken: stringValue(flags['auth-token']) ?? stringValue(flags.t) ?? process.env.LOS_AUTH_TOKEN,
    operatorToken: stringValue(flags['operator-token']) ?? process.env.LOS_OPERATOR_TOKEN,
  };
}

export async function fetchCliResponse(url: string, options: CliRequestOptions = {}): Promise<Response> {
  const { auth = {}, operatorWrite = false, json = false, ...init } = options;
  const headers = new Headers(init.headers);
  if (auth.authToken) headers.set('x-los-auth-token', auth.authToken);
  if (operatorWrite && auth.operatorToken) headers.set('x-los-operator-token', auth.operatorToken);
  if (json) headers.set('Content-Type', 'application/json');
  return await fetch(url, { ...init, headers });
}

export async function requestCliJson(url: string, options: CliRequestOptions = {}): Promise<unknown> {
  const response = await fetchCliResponse(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) as unknown : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
