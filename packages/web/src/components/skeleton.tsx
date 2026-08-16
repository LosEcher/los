// ── Skeleton (Wave 2) ───────────────────────────────────
// Token-based shimmer placeholders. Reuses the daily-skeleton
// shimmer keyframes; color comes from tokens (surface/line).

export function Skeleton({
  width,
  height,
  className,
}: {
  width?: string | number;
  height?: string | number;
  className?: string;
}) {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{
        width: width ?? '100%',
        height: height ?? 12,
      }}
      aria-hidden="true"
    />
  );
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-text">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} height={11} />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={`skeleton-card${className ? ` ${className}` : ''}`} aria-hidden="true">
      <Skeleton width="38%" height={13} />
      <SkeletonText lines={2} />
      <Skeleton width="22%" height={11} />
    </div>
  );
}
