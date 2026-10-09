-- 062_managed_workspaces_backend.sql
-- C1 of ADR 0047 §5.1 (isolation: layered + pluggable backend).
--
-- `vcs_kind` hard-coded the isolation mechanism to 'jj', which conflated
-- "which VCS" with "how to isolate". It becomes `backend`, an extensible id
-- with a closed enum, and the built-in jj backend is named `jj-workspace`
-- (`git-worktree` and `docker` are the other declared backends; see
-- contracts/isolation-backend.yaml).
--
-- Deferred consequence (accepted for this change): `MANAGED_WORKSPACES`
-- consumers only ever call `workspaceRootForTask`, which does not read the
-- `vcs_kind` column at all, so the rename has no consumer to break. Existing
-- rows are rewritten in place ('jj' -> 'jj-workspace').
--
-- Created by ensureManagedWorkspaceStore (agent/src/managed-workspace-store.ts
-- SCHEMA); this migration keeps the migrations-only path in agreement with it
-- (check-migration-drift gate). All statements are guarded so both paths
-- converge idempotently.

-- 1. rename vcs_kind -> backend (guarded: only when the old name still exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'managed_workspaces' AND column_name = 'vcs_kind'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'managed_workspaces' AND column_name = 'backend'
  ) THEN
    ALTER TABLE managed_workspaces RENAME COLUMN vcs_kind TO backend;
  END IF;
END $$;

-- 2. the column may not exist at all yet (fresh DB created by an older SCHEMA)
ALTER TABLE managed_workspaces ADD COLUMN IF NOT EXISTS backend TEXT NOT NULL DEFAULT 'jj-workspace';

-- 3. rewrite legacy values before the CHECK lands
UPDATE managed_workspaces SET backend = 'jj-workspace' WHERE backend = 'jj';

-- 4. drop the old default and install the enum + default
ALTER TABLE managed_workspaces ALTER COLUMN backend SET DEFAULT 'jj-workspace';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'managed_workspaces_backend_chk'
      AND conrelid = 'managed_workspaces'::regclass
  ) THEN
    ALTER TABLE managed_workspaces
      ADD CONSTRAINT managed_workspaces_backend_chk
      CHECK (backend IN ('jj-workspace', 'git-worktree', 'docker'));
  END IF;
END $$;

-- 5. provenance for a backend override. `metadata_json` already exists, so this
--    is documentation-by-query rather than a new column; the inline SCHEMA in
--    managed-workspace-store.ts carries the same comment.
COMMENT ON COLUMN managed_workspaces.backend IS
  'Isolation backend id (jj-workspace | git-worktree | docker). Owned by los; a backend never writes this. See contracts/isolation-backend.yaml (ADR 0047 §5.1).';
