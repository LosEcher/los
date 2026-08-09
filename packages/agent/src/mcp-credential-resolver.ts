/**
 * MCP credential_ref resolver — env and local-file:los-auth/* backends.
 *
 * Fail-closed for oauth, external:*, adapter:*, and unapproved shapes.
 * Resolved secrets are returned only as in-memory env/header fragments;
 * public API responses must never include raw values.
 */

import {
  readLocalAuthSecretResult,
  type ReadLocalAuthSecretOptions,
} from './auth/local-auth-secret.js';
import {
  mcpCredentialRefShapeError,
  type MCPAuthConfig,
} from './mcp-distribution-policy.js';
import type { MCPTransport } from './mcp-server-record.js';

export type MCPResolvedCredential =
  | {
      ok: true;
      /** stdio child env fragment */
      env: Record<string, string>;
      /** remote transport headers (e.g. Authorization) */
      headers: Record<string, string>;
      backend: 'env' | 'local-file' | 'none';
    }
  | { ok: false; reason: string };

export interface ResolveMCPCredentialOptions {
  serverId: string;
  transport: MCPTransport;
  /** Override process.env for tests. */
  env?: NodeJS.ProcessEnv;
  /** Local auth store path override for tests. */
  localAuth?: ReadLocalAuthSecretOptions;
}

export { mcpCredentialRefShapeError } from './mcp-distribution-policy.js';

export async function resolveMCPCredentialRef(
  auth: MCPAuthConfig | undefined,
  opts: ResolveMCPCredentialOptions,
): Promise<MCPResolvedCredential> {
  const mode = auth?.mode ?? 'none';
  if (mode === 'none') {
    return { ok: true, env: {}, headers: {}, backend: 'none' };
  }
  if (mode === 'oauth') {
    return { ok: false, reason: 'unsupported auth mode oauth' };
  }
  if (mode !== 'credential_ref') {
    return { ok: false, reason: `unsupported auth mode ${mode}` };
  }

  const ref = auth?.credentialRef?.trim() ?? '';
  const shapeError = mcpCredentialRefShapeError(ref);
  if (shapeError) return { ok: false, reason: shapeError };

  if (ref.startsWith('env:')) {
    return resolveEnvRef(ref, opts.transport, opts.env ?? process.env);
  }
  if (ref.startsWith('local-file:los-auth/')) {
    return resolveLocalFileRef(ref, opts.transport, opts.localAuth);
  }
  return { ok: false, reason: 'backend_not_implemented' };
}

function resolveEnvRef(
  ref: string,
  transport: MCPTransport,
  envSource: NodeJS.ProcessEnv,
): MCPResolvedCredential {
  const varName = ref.slice('env:'.length);
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(varName)) {
    return { ok: false, reason: 'credential_ref not resolved' };
  }
  const value = envSource[varName];
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: `env credential missing: ${varName}` };
  }
  if (transport === 'stdio') {
    return { ok: true, env: { [varName]: value }, headers: {}, backend: 'env' };
  }
  return {
    ok: true,
    env: {},
    headers: { Authorization: `Bearer ${value}` },
    backend: 'env',
  };
}

function resolveLocalFileRef(
  ref: string,
  transport: MCPTransport,
  localAuth?: ReadLocalAuthSecretOptions,
): MCPResolvedCredential {
  const result = readLocalAuthSecretResult(ref, localAuth);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  if (transport === 'stdio') {
    // Inject under a stable env key derived from the provider key.
    const envKey = `LOS_MCP_AUTH_${sanitizeEnvKey(result.providerKey)}`;
    return { ok: true, env: { [envKey]: result.value }, headers: {}, backend: 'local-file' };
  }
  return {
    ok: true,
    env: {},
    headers: { Authorization: `Bearer ${result.value}` },
    backend: 'local-file',
  };
}

function sanitizeEnvKey(providerKey: string): string {
  return providerKey.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'TOKEN';
}
