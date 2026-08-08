-- 053_observation_dedupe.sql
-- Atomic, scope-aware observation deduplication.

ALTER TABLE observations ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- Earlier builds stored the key only in metadata_json. When historical
-- duplicates exist, keep the newest row as the canonical upsert target.
WITH ranked AS (
  SELECT
    id,
    NULLIF(metadata_json ->> 'dedupeKey', '') AS legacy_key,
    row_number() OVER (
      PARTITION BY
        COALESCE(tenant_id, ''),
        COALESCE(project_id, ''),
        COALESCE(user_id, ''),
        NULLIF(metadata_json ->> 'dedupeKey', '')
      ORDER BY updated_at DESC, id DESC
    ) AS duplicate_rank
  FROM observations
  WHERE NULLIF(metadata_json ->> 'dedupeKey', '') IS NOT NULL
)
UPDATE observations AS observation
SET dedupe_key = CASE
  WHEN ranked.duplicate_rank = 1 THEN ranked.legacy_key
  ELSE NULL
END
FROM ranked
WHERE observation.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_scope_dedupe
  ON observations (
    COALESCE(tenant_id, ''),
    COALESCE(project_id, ''),
    COALESCE(user_id, ''),
    dedupe_key
  )
  WHERE dedupe_key IS NOT NULL;
