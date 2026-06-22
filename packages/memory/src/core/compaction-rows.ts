/**
 * Compaction row helpers — DB row types, row-to-model mapping, candidate normalization.
 * Extracted from compaction.ts to keep below 600 lines.
 */
import type { MemoryCompaction, ProceduralCandidate, CandidateStatus } from './compaction.js';
import type { TranscriptBrief } from '../transcript/transcript-brief.js';
import { normalizeJsonObject, normalizeJsonArray, toIsoString } from '../normalizers.js';

export type CompactionRow = {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  tenant_id: string | null;
  project_id: string | null;
  summary_json: unknown;
  observed_patterns_json: unknown;
  procedural_candidates_json: unknown;
  confidence: string | number;
  evidence_count: string | number;
  created_by: string | null;
  auto_trigger: string | null;
  transcript_brief_json: unknown | null;
  created_at: Date | string;
};

export function rowToCompaction(row: CompactionRow): MemoryCompaction {
  const summary = normalizeJsonObject(row.summary_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    summary,
    observedPatterns: normalizeJsonArray(row.observed_patterns_json),
    proceduralCandidates: normalizeCandidateArray(row.procedural_candidates_json),
    confidence: Number(row.confidence),
    evidenceCount: Number(row.evidence_count),
    createdBy: row.created_by ?? undefined,
    createdAt: toIsoString(row.created_at),
    attestedAt: typeof summary.attestedAt === 'string' ? summary.attestedAt : undefined,
    attestedBy: typeof summary.attestedBy === 'string' ? summary.attestedBy : undefined,
    checkpoint: typeof summary.checkpoint === 'boolean' ? summary.checkpoint : undefined,
    autoTrigger: row.auto_trigger ?? undefined,
    transcriptBrief: row.transcript_brief_json
      ? normalizeJsonObject(row.transcript_brief_json) as unknown as TranscriptBrief
      : undefined,
  };
}

export function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('compaction write returned no row');
  return row;
}

export function normalizeCandidateArray(value: unknown): ProceduralCandidate[] {
  const raw = normalizeJsonArray(value);
  return raw.map((item: Record<string, unknown>): ProceduralCandidate => ({
    name: typeof item.name === 'string' ? item.name : 'unknown',
    content: typeof item.content === 'string' ? item.content : '',
    severity: (item.severity === 'info' || item.severity === 'warn' || item.severity === 'error')
      ? item.severity as 'info' | 'warn' | 'error' : 'info',
    rationale: typeof item.rationale === 'string' ? item.rationale : '',
    confidence: typeof item.confidence === 'number' ? item.confidence : 0,
    status: (item.status === 'draft' || item.status === 'review' || item.status === 'approved' || item.status === 'active' || item.status === 'retired')
      ? item.status as CandidateStatus : 'draft',
    supportingSessionIds: Array.isArray(item.supportingSessionIds)
      ? item.supportingSessionIds.filter((s): s is string => typeof s === 'string')
      : [],
  }));
}
