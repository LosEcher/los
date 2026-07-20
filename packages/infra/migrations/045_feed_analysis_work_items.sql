ALTER TABLE feed_analysis_dispatches
  ADD COLUMN IF NOT EXISTS work_item_id TEXT REFERENCES todos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_feed_analysis_dispatch_work_item
  ON feed_analysis_dispatches(work_item_id);

INSERT INTO todos (
  id, tenant_id, project_id, title, description, kind, status, priority, source,
  trace_id, dedupe_key, task_run_id, session_id, metadata_json, created_at, updated_at
)
SELECT
  'todo-feed-analysis-' || d.id,
  d.tenant_id,
  d.project_id,
  'Feed analysis ' || d.source_system || ' job ' || d.source_job_id,
  'Review feed-analysis dispatch, LOS execution, validated result, and callback delivery evidence.',
  'task',
  CASE WHEN d.status = 'cancelled' THEN 'cancelled' ELSE 'in_progress' END,
  'P2',
  'feed-analysis',
  d.trace_id,
  'feed-analysis-dispatch:' || d.id,
  d.task_run_id,
  d.session_id,
  jsonb_build_object(
    'createdFrom', 'feed-analysis-backfill',
    'feedAnalysis', jsonb_build_object(
      'dispatchId', d.id,
      'sourceSystem', d.source_system,
      'sourceJobId', d.source_job_id
    ),
    'runContract', jsonb_build_object(
      'mode', 'feed-analysis-ingress',
      'phase', CASE
        WHEN d.status = 'completed' THEN 'succeeded'
        WHEN d.status = 'failed' THEN 'blocked'
        ELSE 'executing'
      END,
      'goal', 'Review feed-analysis connector execution and result evidence.',
      'editableSurfaces', '[]'::jsonb,
      'requiredChecks', '[]'::jsonb,
      'allowedSkippedChecks', '[]'::jsonb,
      'stopConditions', '[]'::jsonb,
      'evidenceRequired', jsonb_build_array('feed-analysis dispatch', 'validated result', 'callback delivery'),
      'externalEvidenceAllowed', '[]'::jsonb,
      'rawEvidenceProhibited', '[]'::jsonb,
      'toolMode', 'read-only'
    )
  ),
  d.created_at,
  d.updated_at
FROM feed_analysis_dispatches d
WHERE d.work_item_id IS NULL
ON CONFLICT (id) DO NOTHING;

UPDATE feed_analysis_dispatches
SET work_item_id = 'todo-feed-analysis-' || id
WHERE work_item_id IS NULL;

INSERT INTO work_item_runs (
  id, work_item_id, run_spec_id, task_run_id, session_id, relation_kind, created_at, updated_at
)
SELECT
  'work-link-feed-' || md5(d.id),
  d.work_item_id,
  d.run_spec_id,
  d.task_run_id,
  d.session_id,
  'execution',
  d.created_at,
  d.updated_at
FROM feed_analysis_dispatches d
WHERE d.work_item_id IS NOT NULL
  AND (d.run_spec_id IS NOT NULL OR d.task_run_id IS NOT NULL OR d.session_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM work_item_runs w
    WHERE w.work_item_id = d.work_item_id
      AND (w.run_spec_id = d.run_spec_id OR w.task_run_id = d.task_run_id OR w.session_id = d.session_id)
  )
ON CONFLICT (id) DO NOTHING;
