/**
 * @los/agent/language-contract — Controlled Operator Language (STE-lite).
 *
 * ASD-STE100-inspired output rules for los agents: one status word per claim,
 * evidence markers, short report form, and banned bare completion claims.
 * Prompt text is the single source for identity injection (AP9/AP11).
 * Scoring is pure and deterministic so weekly governance can measure drift.
 */

/** Bumped when scoring rules or prompt blocks change (observation snapshots). */
const LANGUAGE_CONTRACT_VERSION = '1.0.0';

export function languageContractVersion(): string {
  return LANGUAGE_CONTRACT_VERSION;
}

/** Standard-level language block injected into identity prompts. */
const LANGUAGE_CONTRACT_STANDARD = [
  '## Language (operator contract)',
  '1. Lead with the answer. Then evidence.',
  '2. One status word per claim — use runtime terms only:',
  '   succeeded | failed | blocked | cancelled | in_progress | ready | backlog | incomplete.',
  '3. Mark claims: [E] measured | [I] inferred (name the gap) | [U] unchecked.',
  '4. Do not use fixed / shipped / verified / done / all green without a pointer',
  '   (command, path, row id, or check name).',
  '5. If work is incomplete: say INCOMPLETE and the stop reason. Do not narrate retries.',
  '6. Prefer short sentences. One finding or action per sentence in reports.',
].join('\n');

/** Minimal-level language rules (child / remote / pre-execution). */
const LANGUAGE_CONTRACT_MINIMAL = [
  'Language: report FINDING | EVIDENCE | STATUS only.',
  'No process narration (no "Let me…", "Spawning…", "I will…").',
  'If incomplete: INCOMPLETE: <reason>. Never claim done/fixed/shipped without an evidence pointer.',
].join(' ');

export type LanguageClaimMarker = 'E' | 'I' | 'U';

export interface LanguageContractScore {
  chars: number;
  sentences: number;
  evidenceMarkerCount: number;
  hasEvidenceMarker: boolean;
  bareCompletionClaimCount: number;
  processNarrationCount: number;
  hedgeCount: number;
  longSentenceCount: number;
  /** 0–1 composite: higher is better compliance. */
  complianceScore: number;
  flags: string[];
}

export interface LanguageContractThresholds {
  /** Min share of samples with at least one [E]/[I]/[U] (0–1). */
  evidenceMarkerRateMin: number;
  /** Max share with bare completion claims (0–1). */
  bareCompletionClaimRateMax: number;
  /** Max share with process narration (0–1). */
  processNarrationRateMax: number;
  /** Max average hedges per sample. */
  avgHedgeMax: number;
  /** Min mean complianceScore (0–1). */
  meanComplianceMin: number;
}

const DEFAULT_LANGUAGE_THRESHOLDS: LanguageContractThresholds = {
  // Start conservative: markers are new; ramp later via job config.
  evidenceMarkerRateMin: 0.10,
  bareCompletionClaimRateMax: 0.15,
  processNarrationRateMax: 0.30,
  avgHedgeMax: 8,
  meanComplianceMin: 0.45,
};

export function defaultLanguageThresholds(): LanguageContractThresholds {
  return { ...DEFAULT_LANGUAGE_THRESHOLDS };
}

const EVIDENCE_MARKER_RE = /\[(E|I|U)\]/g;
const BARE_COMPLETION_RE =
  /\b(shipped|all\s+green|fully\s+verified|completely\s+fixed|all\s+set|mission\s+accomplished)\b|\b(fixed|verified|done|completed|resolved)\b(?![^.\n]{0,80}\b(pnpm|test|check|curl|path|file|row|id|command|gate|PR\s*#|\.ts|\.md)\b)/gi;
const PROCESS_NARRATION_RE =
  /\b(let me|i will|i'll|spawning|now i(?:'m| am)|going to (?:start|begin|try)|here(?:'s| is) what i(?:'m| am) doing)\b/gi;
const HEDGE_RE = /\b(maybe|might|perhaps|possibly|seems?|appears?|probably|i think|i believe|i guess)\b/gi;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Score a single agent output (or textPreview) against the language contract.
 * Pure function — no I/O.
 */
export function scoreLanguageContract(text: string): LanguageContractScore {
  const normalized = (text ?? '').trim();
  const flags: string[] = [];
  if (!normalized) {
    return {
      chars: 0,
      sentences: 0,
      evidenceMarkerCount: 0,
      hasEvidenceMarker: false,
      bareCompletionClaimCount: 0,
      processNarrationCount: 0,
      hedgeCount: 0,
      longSentenceCount: 0,
      complianceScore: 1,
      flags: ['empty'],
    };
  }

  const sentences = splitSentences(normalized);
  const evidenceMarkerCount = (normalized.match(EVIDENCE_MARKER_RE) ?? []).length;
  const bareCompletionClaimCount = (normalized.match(BARE_COMPLETION_RE) ?? []).length;
  const processNarrationCount = (normalized.match(PROCESS_NARRATION_RE) ?? []).length;
  const hedgeCount = (normalized.match(HEDGE_RE) ?? []).length;
  const longSentenceCount = sentences.filter(s => s.split(/\s+/).length > 35).length;

  if (evidenceMarkerCount === 0 && normalized.length >= 120) flags.push('missing_evidence_marker');
  if (bareCompletionClaimCount > 0) flags.push('bare_completion_claim');
  if (processNarrationCount > 0) flags.push('process_narration');
  if (longSentenceCount > 0) flags.push('long_sentence');

  // Weighted compliance: start at 1, subtract penalties, floor at 0.
  let compliance = 1;
  if (normalized.length >= 120 && evidenceMarkerCount === 0) compliance -= 0.25;
  compliance -= Math.min(0.35, bareCompletionClaimCount * 0.12);
  compliance -= Math.min(0.25, processNarrationCount * 0.08);
  compliance -= Math.min(0.15, longSentenceCount * 0.05);
  compliance -= Math.min(0.15, Math.floor(hedgeCount / 5) * 0.05);
  compliance = Math.max(0, Math.min(1, compliance));

  return {
    chars: normalized.length,
    sentences: sentences.length,
    evidenceMarkerCount,
    hasEvidenceMarker: evidenceMarkerCount > 0,
    bareCompletionClaimCount,
    processNarrationCount,
    hedgeCount,
    longSentenceCount,
    complianceScore: Number(compliance.toFixed(3)),
    flags,
  };
}

export interface LanguageSampleMetrics {
  sampleCount: number;
  withEvidenceMarker: number;
  withBareCompletionClaim: number;
  withProcessNarration: number;
  evidenceMarkerRate: number;
  bareCompletionClaimRate: number;
  processNarrationRate: number;
  avgHedge: number;
  meanCompliance: number;
  flagHistogram: Record<string, number>;
}

export function aggregateLanguageScores(scores: LanguageContractScore[]): LanguageSampleMetrics {
  const sampleCount = scores.length;
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      withEvidenceMarker: 0,
      withBareCompletionClaim: 0,
      withProcessNarration: 0,
      evidenceMarkerRate: 0,
      bareCompletionClaimRate: 0,
      processNarrationRate: 0,
      avgHedge: 0,
      meanCompliance: 1,
      flagHistogram: {},
    };
  }

  let withEvidenceMarker = 0;
  let withBareCompletionClaim = 0;
  let withProcessNarration = 0;
  let hedgeSum = 0;
  let complianceSum = 0;
  const flagHistogram: Record<string, number> = {};

  for (const score of scores) {
    if (score.hasEvidenceMarker) withEvidenceMarker += 1;
    if (score.bareCompletionClaimCount > 0) withBareCompletionClaim += 1;
    if (score.processNarrationCount > 0) withProcessNarration += 1;
    hedgeSum += score.hedgeCount;
    complianceSum += score.complianceScore;
    for (const flag of score.flags) {
      flagHistogram[flag] = (flagHistogram[flag] ?? 0) + 1;
    }
  }

  return {
    sampleCount,
    withEvidenceMarker,
    withBareCompletionClaim,
    withProcessNarration,
    evidenceMarkerRate: withEvidenceMarker / sampleCount,
    bareCompletionClaimRate: withBareCompletionClaim / sampleCount,
    processNarrationRate: withProcessNarration / sampleCount,
    avgHedge: hedgeSum / sampleCount,
    meanCompliance: complianceSum / sampleCount,
    flagHistogram,
  };
}

export interface LanguageThresholdFinding {
  dimension:
    | 'missing_evidence_markers'
    | 'bare_completion_claims'
    | 'process_narration'
    | 'low_compliance'
    | 'hedge_density'
    | 'insufficient_samples'
    | 'cadence_promotion_ready';
  severity: 'info' | 'warn' | 'high';
  detail: string;
}

export function evaluateLanguageThresholds(
  metrics: LanguageSampleMetrics,
  thresholds: LanguageContractThresholds = defaultLanguageThresholds(),
  options: { minSamplesForThresholds?: number } = {},
): LanguageThresholdFinding[] {
  const minSamples = options.minSamplesForThresholds ?? 8;
  const findings: LanguageThresholdFinding[] = [];

  if (metrics.sampleCount < minSamples) {
    findings.push({
      dimension: 'insufficient_samples',
      severity: 'info',
      detail: `Only ${metrics.sampleCount} scored sample(s) in window (need >= ${minSamples} for rate thresholds). Collect more real runs.`,
    });
    return findings;
  }

  if (metrics.evidenceMarkerRate < thresholds.evidenceMarkerRateMin) {
    findings.push({
      dimension: 'missing_evidence_markers',
      severity: metrics.evidenceMarkerRate < thresholds.evidenceMarkerRateMin / 2 ? 'high' : 'warn',
      detail: `Evidence marker rate ${(metrics.evidenceMarkerRate * 100).toFixed(1)}% < min ${(thresholds.evidenceMarkerRateMin * 100).toFixed(0)}% (${metrics.withEvidenceMarker}/${metrics.sampleCount}).`,
    });
  }

  if (metrics.bareCompletionClaimRate > thresholds.bareCompletionClaimRateMax) {
    findings.push({
      dimension: 'bare_completion_claims',
      severity: metrics.bareCompletionClaimRate > thresholds.bareCompletionClaimRateMax * 1.5 ? 'high' : 'warn',
      detail: `Bare completion claim rate ${(metrics.bareCompletionClaimRate * 100).toFixed(1)}% > max ${(thresholds.bareCompletionClaimRateMax * 100).toFixed(0)}% (${metrics.withBareCompletionClaim}/${metrics.sampleCount}).`,
    });
  }

  if (metrics.processNarrationRate > thresholds.processNarrationRateMax) {
    findings.push({
      dimension: 'process_narration',
      severity: 'warn',
      detail: `Process narration rate ${(metrics.processNarrationRate * 100).toFixed(1)}% > max ${(thresholds.processNarrationRateMax * 100).toFixed(0)}% (${metrics.withProcessNarration}/${metrics.sampleCount}).`,
    });
  }

  if (metrics.avgHedge > thresholds.avgHedgeMax) {
    findings.push({
      dimension: 'hedge_density',
      severity: 'info',
      detail: `Average hedge words per sample ${metrics.avgHedge.toFixed(1)} > max ${thresholds.avgHedgeMax}.`,
    });
  }

  if (metrics.meanCompliance < thresholds.meanComplianceMin) {
    findings.push({
      dimension: 'low_compliance',
      severity: metrics.meanCompliance < thresholds.meanComplianceMin * 0.7 ? 'high' : 'warn',
      detail: `Mean compliance ${metrics.meanCompliance.toFixed(3)} < min ${thresholds.meanComplianceMin.toFixed(2)}.`,
    });
  }

  return findings;
}

/** Format language contract for identity prompt injection. */
export function formatLanguageContractForPrompt(level: 'none' | 'minimal' | 'standard' | 'full'): string {
  if (level === 'none') return '';
  if (level === 'minimal') return LANGUAGE_CONTRACT_MINIMAL;
  return LANGUAGE_CONTRACT_STANDARD;
}
