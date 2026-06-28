-- 021_skills_rules_memory.sql
-- skills, rules, observations + indexes (observations base table from memory/core/store.ts)

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  run_mode TEXT NOT NULL DEFAULT 'manual',
  tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  usage_count INTEGER NOT NULL DEFAULT 0,
  version_hash TEXT NOT NULL DEFAULT '',
  last_used TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills((metadata_json->>'scope'));
CREATE INDEX IF NOT EXISTS idx_skills_layer ON skills((metadata_json->>'skillLayer'));
CREATE INDEX IF NOT EXISTS idx_skills_archived ON skills((metadata_json->>'archived'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_scope_name_unique ON skills(COALESCE(metadata_json->>'scope', 'project'), name);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'warn',
  enforcement_mode TEXT NOT NULL DEFAULT 'advisory',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status);
CREATE INDEX IF NOT EXISTS idx_rules_severity ON rules(severity);
CREATE INDEX IF NOT EXISTS idx_rules_scope ON rules((metadata_json->>'scope'));
CREATE INDEX IF NOT EXISTS idx_rules_layer ON rules((metadata_json->>'ruleLayer'));
CREATE INDEX IF NOT EXISTS idx_rules_archived ON rules((metadata_json->>'archived'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_scope_name_unique ON rules(COALESCE(metadata_json->>'scope', 'project'), name);
