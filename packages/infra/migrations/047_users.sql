-- 047_users.sql
-- User accounts for web login (JWT-based authentication).
-- When users exist, the shared token (LOS_AUTH_TOKEN) is still accepted
-- for backward compatibility. Operator token (LOS_OPERATOR_TOKEN) always
-- takes priority.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('operator', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
