/**
 * Sparkline — dependency-free inline SVG trend line.
 *
 * Used by the usage page for per-provider latency/error trends. Renders a
 * minimal polyline with an optional area fill; hover exposes the raw values
 * through the title attribute.
 */
import { useId } from 'react';

export function Sparkline({
  values,
  width = 96,
  height = 24,
  color = 'var(--accent)',
  title,
}: {
  values: readonly (number | null)[];
  width?: number;
  height?: number;
  color?: string;
  title?: string;
}) {
  const gradientId = useId().replace(/[:]/g, '');
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) {
    return <span className="sparkline sparkline-empty" title={title ?? ''}>—</span>;
  }

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const point = (value: number | null, index: number): [number, number] | null => {
    if (value === null || !Number.isFinite(value)) return null;
    const x = values.length <= 1 ? width / 2 : pad + (index / (values.length - 1)) * innerW;
    const y = pad + (1 - (value - min) / span) * innerH;
    return [x, y];
  };

  const coords = values.map(point);
  const line = coords
    .filter((c): c is [number, number] => c !== null)
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');

  // Area path: close the polyline down to the baseline.
  const first = coords.find((c): c is [number, number] => c !== null);
  const last = [...coords].reverse().find((c): c is [number, number] => c !== null);
  const area = first && last && line.length > 0
    ? `M ${first[0].toFixed(1)},${first[1].toFixed(1)} L ${line.split(' ').slice(1).join(' L ')} L ${last[0].toFixed(1)},${height - pad} L ${first[0].toFixed(1)},${height - pad} Z`
    : '';

  const label = title ?? values.map(v => (v === null ? '—' : `${Math.round(v)}ms`)).join(' → ');

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area ? <path d={area} fill={`url(#${gradientId})`} /> : null}
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
