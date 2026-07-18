-- 036_provider_accounts: stable provider identity and opaque secret references

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
