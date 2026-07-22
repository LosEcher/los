import { createHash } from 'node:crypto';

export type PiKernelShadowResultEnvelopeShape =
  | 'json_object'
  | 'fenced_json'
  | 'prefixed_fenced_json'
  | 'other';

export interface PiKernelShadowResultComparison {
  kind: 'json_package_name';
  productionValueHash?: string;
  candidateValueHash?: string;
  productionEnvelopeShape: PiKernelShadowResultEnvelopeShape;
  candidateEnvelopeShape: PiKernelShadowResultEnvelopeShape;
  productionTextLength: number;
  candidateTextLength: number;
}

export function _comparePiKernelShadowPackageNameResults(
  productionText: string | undefined,
  candidateText: string | undefined,
): PiKernelShadowResultComparison {
  const productionValue = _readPiKernelShadowPackageNameValue(productionText);
  const candidateValue = _readPiKernelShadowPackageNameValue(candidateText);
  return {
    kind: 'json_package_name',
    ...(productionValue ? { productionValueHash: valueHash(productionValue) } : {}),
    ...(candidateValue ? { candidateValueHash: valueHash(candidateValue) } : {}),
    productionEnvelopeShape: resultEnvelopeShape(productionText),
    candidateEnvelopeShape: resultEnvelopeShape(candidateText),
    productionTextLength: productionText?.length ?? 0,
    candidateTextLength: candidateText?.length ?? 0,
  };
}

export function _readPiKernelShadowPackageNameValue(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let value = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(value);
  if (fenced) value = fenced[1]!.trim();
  return packageNameFromJson(value);
}

export function _parsePiKernelShadowResultComparison(
  value: unknown,
): PiKernelShadowResultComparison | undefined {
  const record = asRecord(value);
  if (record.kind !== 'json_package_name') return undefined;
  if (record.productionValueHash !== undefined && typeof record.productionValueHash !== 'string') return undefined;
  if (record.candidateValueHash !== undefined && typeof record.candidateValueHash !== 'string') return undefined;
  if (!isEnvelopeShape(record.productionEnvelopeShape) || !isEnvelopeShape(record.candidateEnvelopeShape)) return undefined;
  if (!isNonNegativeInteger(record.productionTextLength) || !isNonNegativeInteger(record.candidateTextLength)) return undefined;
  return {
    kind: 'json_package_name',
    ...(typeof record.productionValueHash === 'string' ? { productionValueHash: record.productionValueHash } : {}),
    ...(typeof record.candidateValueHash === 'string' ? { candidateValueHash: record.candidateValueHash } : {}),
    productionEnvelopeShape: record.productionEnvelopeShape,
    candidateEnvelopeShape: record.candidateEnvelopeShape,
    productionTextLength: record.productionTextLength,
    candidateTextLength: record.candidateTextLength,
  };
}

function resultEnvelopeShape(text: string | undefined): PiKernelShadowResultEnvelopeShape {
  if (!text) return 'other';
  const value = text.trim();
  if (packageNameFromJson(value) !== undefined) return 'json_object';
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(value);
  if (fenced && packageNameFromJson(fenced[1]!.trim()) !== undefined) return 'fenced_json';
  const embeddedFence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(value);
  if (embeddedFence && packageNameFromJson(embeddedFence[1]!.trim()) !== undefined) {
    return 'prefixed_fenced_json';
  }
  return 'other';
}

function packageNameFromJson(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.packageName !== 'string') return undefined;
    return record.packageName;
  } catch {
    return undefined;
  }
}

function valueHash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isEnvelopeShape(value: unknown): value is PiKernelShadowResultEnvelopeShape {
  return value === 'json_object' || value === 'fenced_json'
    || value === 'prefixed_fenced_json' || value === 'other';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
