// ── Numeric formatters (Wave 4, P2-2) ──────────────────
// Consistent number presentation across data-dense surfaces:
// thousands separators, compact token counts, USD costs.

export function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US');
}

export function formatTokenCount(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  const digits = value >= 100 ? 0 : value >= 1 ? 2 : 3;
  return `$${value.toFixed(digits)}`;
}
