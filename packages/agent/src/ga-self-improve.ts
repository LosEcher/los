/**
 * GA Self-Improvement — extracts durable principles from loop results.
 *
 * Inspired by Warp's Buzz agent 7-step learning cycle:
 *   1. Identify what went wrong (from failure evidence)
 *   2. Ask why (root cause behind the symptom)
 *   3. Zoom out to the pattern (is the lesson generalizable?)
 *   4. Check against existing principles (sharpen, edit, delete, or add)
 *   5. Write it as a principle, not a rule
 *   6. Place it in the correct section of the skill file
 *   7. Commit — open a candidate for human review
 *
 * In los, this writes to procedural_candidates table rather than .md skill files
 * (TypeScript-native approach). Candidates require human review before becoming active.
 */
import { getLogger } from '@los/infra/logger';
import { getDb } from '@los/infra/db';
import { PROCEDURAL_CANDIDATES_DDL } from '@los/infra/procedural-candidates-ddl';
import type { GaLoopResult, GaLoopPhase } from './governance-jobs-types.js';

const log = getLogger('ga-self-improve');

export interface ExtractedPrinciple {
  /** Short name for the principle */
  name: string;
  /** What situation does this principle address? */
  context: string;
  /** The principle itself — describes how to think, not what to do */
  principle: string;
  /** Evidence from loop runs */
  evidence: string[];
  /** How does this sharpen, complement, or replace existing principles? */
  relationshipToExisting: 'new' | 'sharpen' | 'replace' | 'complement';
  /** Which existing principle does this relate to? */
  relatedPrinciple?: string;
  /** Severity: how often does this pattern cause problems? */
  severity: 'error' | 'warning' | 'info';
}

/**
 * Extract durable principles from GA loop results.
 *
 * Analyzes the phases of a completed loop to detect patterns worth preserving:
 *   - Repeated failures → root cause patterns
 *   - Successful fixes → what worked and why
 *   - Phase transitions → workflow efficiency patterns
 */
export function extractLoopPrinciples(result: GaLoopResult): ExtractedPrinciple[] {
  const principles: ExtractedPrinciple[] = [];

  // ── Pattern 1: Repeated retries suggest a systematic issue ──
  if (result.retried && !result.fixSucceeded) {
    const retryPhases = result.phases.filter(p => p.phase === 'retry');
    if (retryPhases.length >= 2) {
      principles.push({
        name: `repeated-fix-failure-${result.jobType}`,
        context: `GA loop ${result.jobType} attempted ${retryPhases.length} retries without success`,
        principle: `When auto-fix for ${result.jobType} fails repeatedly, prefer escalation over further retries. Analyze the root cause of the fix failure before attempting another automated round.`,
        evidence: retryPhases.map(p => p.detail ?? `Retry ${p.attemptNumber}`),
        relationshipToExisting: 'new',
        severity: 'error',
      });
    }
  }

  // ── Pattern 2: Successful fix → document the strategy ──
  if (result.fixSucceeded && result.fixApplied) {
    const verifyPhase = result.phases.find(p => p.phase === 'verify_result');
    principles.push({
      name: `successful-fix-${result.jobType}`,
      context: `GA loop ${result.jobType} auto-fix succeeded and verified clean`,
      principle: `The auto-fix strategy for ${result.jobType} produced correct results. Continue using this strategy; consider reducing maxAutoFixAttempts if it consistently succeeds on first try.`,
      evidence: [verifyPhase?.detail ?? 'Fix applied and verified'],
      relationshipToExisting: 'complement',
      severity: 'info',
    });
  }

  // ── Pattern 3: Escalation required → the auto-fix is insufficient ──
  if (result.escalated) {
    const escalatePhase = result.phases.find(p => p.phase === 'escalated');
    principles.push({
      name: `auto-fix-escalation-${result.jobType}`,
      context: `GA loop ${result.jobType} escalated after max retries`,
      principle: `Current auto-fix strategy for ${result.jobType} is insufficient for the detected findings. Escalation was necessary. Consider refining the auto-fix logic or increasing maxAutoFixAttempts.`,
      evidence: [
        escalatePhase?.detail ?? result.escalatedReason ?? 'Escalated',
        ...result.phases.filter(p => p.phase === 'fix_attempted').map(p => p.detail ?? `Fix attempt ${p.attemptNumber}`),
      ],
      relationshipToExisting: 'sharpen',
      severity: 'warning',
    });
  }

  // ── Pattern 4: Audit threw an error → systemic issue ──
  if (result.error) {
    principles.push({
      name: `audit-error-${result.jobType}`,
      context: `GA loop ${result.jobType} audit threw an error`,
      principle: `The audit step for ${result.jobType} encountered an unexpected error: "${result.error}". This should not happen — investigate the audit function for unhandled edge cases.`,
      evidence: [result.error],
      relationshipToExisting: 'new',
      severity: 'error',
    });
  }

  // ── Pattern 5: Phase timing insights ──
  const phaseSequence = result.phases.map(p => p.phase);
  if (phaseSequence.includes('retry') && phaseSequence.includes('escalated')) {
    principles.push({
      name: `retry-escalation-pattern-${result.jobType}`,
      context: `GA loop ${result.jobType} exhausted retries and escalated`,
      principle: `When retries don't resolve findings within the allotted attempts, the escalation path works correctly. Monitor escalation rate — if > 30% for this job type, consider reviewing the auto-fix strategy.`,
      evidence: [phaseSequence.join(' → ')],
      relationshipToExisting: 'complement',
      severity: 'info',
    });
  }

  return principles;
}

/** Align with @los/memory MIN_CANDIDATE_CONFIDENCE (agent cannot import memory — circular). */
const MIN_GA_CANDIDATE_CONFIDENCE = 0.5;

function gaConfidence(severity: ExtractedPrinciple['severity']): number {
  if (severity === 'error') return 0.65;
  if (severity === 'warning') return 0.55;
  return 0.4; // info — below threshold, skipped
}

function gaSeverity(severity: ExtractedPrinciple['severity']): 'info' | 'warn' | 'error' {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warn';
  return 'info';
}

/**
 * Persist extracted principles to the procedural_candidates table.
 * Returns the number of candidates created.
 *
 * Cannot call createProceduralCandidate (@los/memory) — agent↔memory circular dep.
 * Mirrors its evidence gate: confidence ≥ 0.5, explicit confidence column, stable id.
 */
export async function persistLoopPrinciples(
  result: GaLoopResult,
  tenantId?: string,
  projectId?: string,
): Promise<number> {
  const principles = extractLoopPrinciples(result);
  if (principles.length === 0) return 0;

  try {
    const db = getDb();
    await db.exec(PROCEDURAL_CANDIDATES_DDL);

    let created = 0;
    for (const p of principles) {
      const confidence = gaConfidence(p.severity);
      if (confidence < MIN_GA_CANDIDATE_CONFIDENCE) {
        log.debug(`Skipping GA principle "${p.name}" — confidence ${confidence} < ${MIN_GA_CANDIDATE_CONFIDENCE}`);
        continue;
      }
      try {
        // Stable id for upsert/dedup (no Date.now in name).
        const name = p.name.slice(0, 128);
        const id = `pc-ga-auto-${name.slice(0, 64)}`;
        const content =
          `**Context:** ${p.context}\n\n**Principle:** ${p.principle}\n\n**Evidence:**\n${p.evidence.map(e => `- ${e}`).join('\n')}`;
        await db.query(
          `INSERT INTO procedural_candidates (
             id, name, content, severity, rationale, confidence, status,
             compaction_id, session_id, tenant_id, project_id, evidence_json
           ) VALUES ($1, $2, $3, $4, $5, $6, 'draft', 'ga-auto', 'ga-system', $7, $8, $9::jsonb)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             severity = EXCLUDED.severity,
             rationale = EXCLUDED.rationale,
             confidence = GREATEST(procedural_candidates.confidence, EXCLUDED.confidence),
             evidence_json = EXCLUDED.evidence_json,
             updated_at = now()`,
          [
            id,
            name,
            content,
            gaSeverity(p.severity),
            p.context,
            confidence,
            tenantId ?? null,
            projectId ?? null,
            JSON.stringify({
              source: 'ga_loop',
              jobType: result.jobType,
              jobId: result.jobId,
              relationshipToExisting: p.relationshipToExisting,
              relatedPrinciple: p.relatedPrinciple ?? null,
              supportingSessionIds: ['ga-system'],
              tenantId: tenantId ?? null,
              projectId: projectId ?? null,
            }),
          ],
        );
        created += 1;
      } catch (err) {
        log.warn(`Failed to persist principle "${p.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (created > 0) log.info(`GA self-improvement: persisted ${created} principle(s) from ${result.jobType} loop`);

    return created;
  } catch (err) {
    log.warn(`GA self-improvement persistence failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
