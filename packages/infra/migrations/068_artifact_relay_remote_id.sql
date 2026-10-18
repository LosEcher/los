-- 068_artifact_relay_remote_id: namespace the owner-side artifact id
--
-- 067 keyed the relay index by the gateway artifact id, but the owner executor
-- shares the `artifacts` table. Reusing the same id made the gateway and owner
-- rows overwrite each other. Store the owner-side id explicitly.

ALTER TABLE artifact_relay_index
  ADD COLUMN IF NOT EXISTS remote_artifact_id TEXT;
