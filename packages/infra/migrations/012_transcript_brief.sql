-- 2026-06-18: transcript_brief_json column for structured transcript compression

ALTER TABLE memory_compactions
ADD COLUMN IF NOT EXISTS transcript_brief_json JSONB;
