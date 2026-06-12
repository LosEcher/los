import type { ReactNode } from 'react';

export function RunField({ label, title, variant = 'toolbar', children }: {
  label: string; title: string; variant?: 'toolbar' | 'panel' | 'group'; children: ReactNode;
}) {
  if (variant === 'group') {
    return (
      <div className="run-field run-field-group" title={title} role="group" aria-label={label}>
        <span>{label}</span>
        {children}
      </div>
    );
  }

  return (
    <label className={`run-field ${variant === 'panel' ? 'panel-field' : ''}`} title={title}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function ContextChip({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`context-chip ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
