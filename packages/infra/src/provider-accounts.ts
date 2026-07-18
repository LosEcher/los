import { z } from 'zod';
import { getDb } from './db.js';

export const ProviderAccountAuthModeSchema = z.enum([
  'oauth',
  'api_key',
  'external_ref',
  'adapter',
]);
export type ProviderAccountAuthMode = z.infer<typeof ProviderAccountAuthModeSchema>;

export const ProviderAccountStateSchema = z.enum([
  'active',
  'disabled',
  'auth_failed',
  'unavailable',
]);
export type ProviderAccountState = z.infer<typeof ProviderAccountStateSchema>;

export const ProviderAccountSecretScopeSchema = z.enum([
  'local_node',
  'named_node',
  'external_backend',
]);
export type ProviderAccountSecretScope = z.infer<typeof ProviderAccountSecretScopeSchema>;

const StableIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const ProviderKeySchema = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const SecretRefSchema = z.string().trim().refine(isApprovedSecretRef, {
  message: 'secretRef must be an approved opaque backend reference',
});
const VerifiedAtSchema = z.string().datetime({ offset: true });

export const CreateProviderAccountInputSchema = z.object({
  id: StableIdSchema,
  provider: ProviderKeySchema,
  authMode: ProviderAccountAuthModeSchema,
  displayLabel: z.string().trim().min(1).max(160),
  secretRef: SecretRefSchema,
  state: ProviderAccountStateSchema,
  secretScope: ProviderAccountSecretScopeSchema,
  nodeId: StableIdSchema.optional(),
  verifiedAt: VerifiedAtSchema.optional(),
}).strict().superRefine(validateNodeScope);
export type CreateProviderAccountInput = z.infer<typeof CreateProviderAccountInputSchema>;

export const ReplaceProviderAccountCredentialInputSchema = z.object({
  id: StableIdSchema,
  expectedCredentialGeneration: z.number().int().min(1),
  authMode: ProviderAccountAuthModeSchema,
  secretRef: SecretRefSchema,
  secretScope: ProviderAccountSecretScopeSchema,
  nodeId: StableIdSchema.optional(),
}).strict().superRefine(validateNodeScope);
export type ReplaceProviderAccountCredentialInput = z.infer<
  typeof ReplaceProviderAccountCredentialInputSchema
>;

export const SetProviderAccountStateInputSchema = z.object({
  id: StableIdSchema,
  expectedCredentialGeneration: z.number().int().min(1),
  state: ProviderAccountStateSchema,
  verifiedAt: VerifiedAtSchema.nullable().optional(),
}).strict();
export type SetProviderAccountStateInput = z.infer<typeof SetProviderAccountStateInputSchema>;

export interface ProviderAccountRecord {
  id: string;
  provider: string;
  authMode: ProviderAccountAuthMode;
  displayLabel: string;
  secretRef: string;
  state: ProviderAccountState;
  credentialGeneration: number;
  secretScope: ProviderAccountSecretScope;
  nodeId?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListProviderAccountsOptions {
  provider?: string;
  state?: ProviderAccountState;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  display_label TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  credential_generation INTEGER NOT NULL DEFAULT 1,
  secret_scope TEXT NOT NULL,
  node_id TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_accounts_id_check
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT provider_accounts_provider_check
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT provider_accounts_auth_mode_check
    CHECK (auth_mode IN ('oauth', 'api_key', 'external_ref', 'adapter')),
  CONSTRAINT provider_accounts_display_label_check
    CHECK (length(btrim(display_label)) BETWEEN 1 AND 160),
  CONSTRAINT provider_accounts_secret_ref_check
    CHECK (secret_ref ~ '^(local-file:[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}|env:[A-Z][A-Z0-9_]{1,127}|external:[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}|adapter:[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._/-]{0,190})$'),
  CONSTRAINT provider_accounts_state_check
    CHECK (state IN ('active', 'disabled', 'auth_failed', 'unavailable')),
  CONSTRAINT provider_accounts_generation_check
    CHECK (credential_generation >= 1),
  CONSTRAINT provider_accounts_secret_scope_check
    CHECK (secret_scope IN ('local_node', 'named_node', 'external_backend')),
  CONSTRAINT provider_accounts_node_scope_check
    CHECK (
      (secret_scope = 'named_node' AND node_id IS NOT NULL
        AND node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
      OR (secret_scope <> 'named_node' AND node_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider_state
  ON provider_accounts(provider, state);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_node
  ON provider_accounts(node_id)
  WHERE node_id IS NOT NULL;
`;

let initialized = false;

export async function ensureProviderAccountStore(): Promise<void> {
  if (initialized) return;
  await getDb().exec(SCHEMA);
  initialized = true;
}

export async function createProviderAccount(
  input: CreateProviderAccountInput,
): Promise<ProviderAccountRecord> {
  const value = CreateProviderAccountInputSchema.parse(input);
  await ensureProviderAccountStore();
  const result = await getDb().query<ProviderAccountRow>(
    `INSERT INTO provider_accounts (
       id, provider, auth_mode, display_label, secret_ref, state,
       credential_generation, secret_scope, node_id, verified_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)
     RETURNING *`,
    [
      value.id,
      value.provider,
      value.authMode,
      value.displayLabel,
      value.secretRef,
      value.state,
      value.secretScope,
      value.nodeId ?? null,
      value.verifiedAt ?? null,
    ],
  );
  return rowToRecord(assertRow(result.rows[0]));
}

export async function loadProviderAccount(id: string): Promise<ProviderAccountRecord | null> {
  const accountId = StableIdSchema.parse(id);
  await ensureProviderAccountStore();
  const result = await getDb().query<ProviderAccountRow>(
    'SELECT * FROM provider_accounts WHERE id = $1',
    [accountId],
  );
  return result.rows[0] ? rowToRecord(result.rows[0]) : null;
}

export async function listProviderAccounts(
  options: ListProviderAccountsOptions = {},
): Promise<ProviderAccountRecord[]> {
  await ensureProviderAccountStore();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.provider !== undefined) {
    params.push(ProviderKeySchema.parse(options.provider));
    clauses.push(`provider = $${params.length}`);
  }
  if (options.state !== undefined) {
    params.push(ProviderAccountStateSchema.parse(options.state));
    clauses.push(`state = $${params.length}`);
  }
  params.push(normalizeLimit(options.limit));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await getDb().query<ProviderAccountRow>(
    `SELECT * FROM provider_accounts
     ${where}
     ORDER BY provider, display_label, id
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToRecord);
}

export async function replaceProviderAccountCredential(
  input: ReplaceProviderAccountCredentialInput,
): Promise<ProviderAccountRecord> {
  const value = ReplaceProviderAccountCredentialInputSchema.parse(input);
  await ensureProviderAccountStore();
  const result = await getDb().query<ProviderAccountRow>(
    `UPDATE provider_accounts
        SET auth_mode = $3,
            secret_ref = $4,
            secret_scope = $5,
            node_id = $6,
            credential_generation = credential_generation + 1,
            verified_at = NULL,
            updated_at = now()
      WHERE id = $1 AND credential_generation = $2
      RETURNING *`,
    [
      value.id,
      value.expectedCredentialGeneration,
      value.authMode,
      value.secretRef,
      value.secretScope,
      value.nodeId ?? null,
    ],
  );
  return resolveFencedUpdate(result.rows[0], value.id, value.expectedCredentialGeneration);
}

export async function setProviderAccountState(
  input: SetProviderAccountStateInput,
): Promise<ProviderAccountRecord> {
  const value = SetProviderAccountStateInputSchema.parse(input);
  await ensureProviderAccountStore();
  const writesVerifiedAt = Object.hasOwn(value, 'verifiedAt');
  const result = await getDb().query<ProviderAccountRow>(
    `UPDATE provider_accounts
        SET state = $3,
            verified_at = CASE WHEN $4 THEN $5::timestamptz ELSE verified_at END,
            updated_at = now()
      WHERE id = $1 AND credential_generation = $2
      RETURNING *`,
    [
      value.id,
      value.expectedCredentialGeneration,
      value.state,
      writesVerifiedAt,
      value.verifiedAt ?? null,
    ],
  );
  return resolveFencedUpdate(result.rows[0], value.id, value.expectedCredentialGeneration);
}

class ProviderAccountGenerationConflictError extends Error {
  readonly code = 'provider_account_generation_conflict';

  constructor(readonly accountId: string, readonly expectedGeneration: number) {
    super(`provider account ${accountId} is missing or credential generation is not ${expectedGeneration}`);
    this.name = 'ProviderAccountGenerationConflictError';
  }
}

function resolveFencedUpdate(
  row: ProviderAccountRow | undefined,
  accountId: string,
  expectedGeneration: number,
): ProviderAccountRecord {
  if (!row) throw new ProviderAccountGenerationConflictError(accountId, expectedGeneration);
  return rowToRecord(row);
}

function validateNodeScope(
  value: { secretScope: ProviderAccountSecretScope; nodeId?: string },
  context: z.RefinementCtx,
): void {
  if (value.secretScope === 'named_node' && !value.nodeId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['nodeId'], message: 'named_node requires nodeId' });
  }
  if (value.secretScope !== 'named_node' && value.nodeId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['nodeId'], message: 'nodeId is only valid for named_node' });
  }
}

function isApprovedSecretRef(value: string): boolean {
  return /^(?:local-file:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}|env:[A-Z][A-Z0-9_]{1,127}|external:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}|adapter:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190})$/.test(value);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  return z.number().int().min(1).max(1000).parse(value);
}

type ProviderAccountRow = {
  id: string;
  provider: string;
  auth_mode: string;
  display_label: string;
  secret_ref: string;
  state: string;
  credential_generation: number;
  secret_scope: string;
  node_id: string | null;
  verified_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: ProviderAccountRow): ProviderAccountRecord {
  return {
    id: row.id,
    provider: row.provider,
    authMode: ProviderAccountAuthModeSchema.parse(row.auth_mode),
    displayLabel: row.display_label,
    secretRef: row.secret_ref,
    state: ProviderAccountStateSchema.parse(row.state),
    credentialGeneration: Number(row.credential_generation),
    secretScope: ProviderAccountSecretScopeSchema.parse(row.secret_scope),
    nodeId: row.node_id ?? undefined,
    verifiedAt: row.verified_at ? toIsoString(row.verified_at) : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function assertRow(row: ProviderAccountRow | undefined): ProviderAccountRow {
  if (!row) throw new Error('provider account write returned no row');
  return row;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
