import type { FeedAnalysisOutputKind, FeedAnalysisPlatform } from './feed-analysis-types.js';

const OUTPUTS = new Set<FeedAnalysisOutputKind>(['daily_digest', 'content_brief', 'platform_draft']);
const PLATFORMS = new Set<FeedAnalysisPlatform>(['xiaohongshu', 'zhihu', 'weibo', 'x']);

export function buildArtifactContractInstructions(
  requestedOutputs: FeedAnalysisOutputKind[],
  targetPlatformsValue: unknown,
): string[] {
  const instructions = [
    'Allowed artifact kind values are exactly: daily_digest, content_brief, platform_draft.',
    `Emit artifacts only for these requested kinds: ${requestedOutputs.join(', ') || 'daily_digest'}. Do not add insight, matrix, analysis, or other artifact kinds.`,
    'Each artifact requires kind and body; optional fields are platform, title, titleCandidates, hashtags, citationRefs, and structuredPayload.',
  ];
  if (!requestedOutputs.includes('platform_draft')) return instructions;
  const targetPlatforms = normalizeTargetPlatforms(targetPlatformsValue);
  const platforms = targetPlatforms.length > 0 ? targetPlatforms : ['x'];
  return [
    ...instructions,
    `For platform_draft, emit one separate artifact for each target platform: ${platforms.join(', ')}.`,
    'Every platform_draft must contain a scalar platform equal to one of: x, zhihu, xiaohongshu, weibo.',
    'Never combine drafts for multiple platforms in one artifact.',
    `Required platform_draft shapes: ${platforms.map(platform => JSON.stringify({ kind: 'platform_draft', platform, body: '...' })).join(', ')}`,
  ];
}

export function selectRequestedArtifacts(
  values: unknown[],
  requestedOutputs: FeedAnalysisOutputKind[],
): { values: Array<{ value: unknown; index: number }>; warnings: string[] } {
  const requested = new Set(requestedOutputs);
  const selected: Array<{ value: unknown; index: number }> = [];
  const warnings: string[] = [];
  for (const [index, value] of values.entries()) {
    const kind = readString(readObject(value).kind);
    if (!kind || !OUTPUTS.has(kind as FeedAnalysisOutputKind)) {
      warnings.push(`Ignored unsupported artifact kind at index ${index}: ${kind ?? 'missing'}`);
      continue;
    }
    if (!requested.has(kind as FeedAnalysisOutputKind)) {
      warnings.push(`Ignored unrequested artifact kind at index ${index}: ${kind}`);
      continue;
    }
    selected.push({ value, index });
  }
  return { values: selected, warnings };
}

export function readFeedAnalysisWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const direct = readString(item);
    if (direct) return [direct];
    const message = readString(readObject(item).message);
    return message ? [message] : [];
  });
}

function normalizeTargetPlatforms(value: unknown): FeedAnalysisPlatform[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is FeedAnalysisPlatform =>
    typeof item === 'string' && PLATFORMS.has(item as FeedAnalysisPlatform),
  ))];
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
