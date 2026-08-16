import { type ReactNode } from 'react';

// ── EmptyState (Wave 2) ─────────────────────────────────
// Structured empty/zero-data presentation: icon + title +
// optional description + optional action. Replaces bare
// one-line EmptyText in high-frequency surfaces.

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? ' empty-state-compact' : ''}`}>
      {icon ? <div className="empty-state-icon">{icon}</div> : null}
      <strong className="empty-state-title">{title}</strong>
      {description ? <p className="empty-state-description">{description}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
