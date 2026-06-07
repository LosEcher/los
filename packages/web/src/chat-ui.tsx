import type { ReactNode } from 'react';

export function RunField({ label, title, variant = 'toolbar', children }: {
  label: string; title: string; variant?: 'toolbar' | 'panel'; children: ReactNode;
}) {
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
