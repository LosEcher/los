-- 063_dsh_session_catalog.sql
-- P1 L1-2：DSH 会话的**只读跨项目投射**（los 侧）。
--
-- 依据 docs/architecture/2026-10-08-p1-cross-project-observability.md L1-2。
-- 数据源是 DSH 的 ~/.dsh/storages/session-index.db（SQLite）；本投射**只读**它，
-- **不写 DSH 侧任何文件** —— 投射落在 los 自己的 Postgres。
--
-- 为什么需要 `path_state`/`path_reason`：项目根从 syncthing/project 迁到
-- syncfolder/project，历史会话的 cwd 仍指旧路径。解析三态（current/resolved/unknown）
-- 与 unknown 的原因（no-map / unmapped）必须落库，否则"无法归属的历史"会被静默丢掉。
--
-- Created by ensureDshSessionCatalogStore (agent/src/dsh-session-catalog.ts SCHEMA);
-- this migration keeps the migrations-only path in agreement (check-migration-drift gate).

CREATE TABLE IF NOT EXISTS dsh_session_catalog (
  session_id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  project_key TEXT NOT NULL,
  path_state TEXT NOT NULL,
  path_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_event_at TIMESTAMPTZ,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  llm_requests INTEGER NOT NULL DEFAULT 0,
  interrupted_turns INTEGER NOT NULL DEFAULT 0,
  duration_ms BIGINT,
  as_of TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dsh_session_catalog_project
  ON dsh_session_catalog(project_key, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_dsh_session_catalog_state
  ON dsh_session_catalog(path_state);

CREATE TABLE IF NOT EXISTS dsh_session_pain (
  project_key TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  pattern_version TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  as_of TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_key, pattern_key, pattern_version)
);

CREATE TABLE IF NOT EXISTS dsh_context_injection (
  day DATE NOT NULL,
  project_key TEXT NOT NULL,
  runtime_context_injections INTEGER NOT NULL DEFAULT 0,
  skill_catalog_injections INTEGER NOT NULL DEFAULT 0,
  avg_assistant_chars INTEGER,
  max_assistant_chars INTEGER,
  as_of TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (day, project_key)
);
