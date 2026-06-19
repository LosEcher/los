import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCcw } from 'lucide-react';

export type StatusState = 'live' | 'partial' | 'reserved';

// ── StatusPill ──────────────────────────────────────────

export function StatusPill({ status }: { status: StatusState }) {
  return <span className={`status-pill ${status}`}>{status}</span>;
}

// ── FormField ───────────────────────────────────────────

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// ── Fact / Definition ───────────────────────────────────

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Definition({ term, text }: { term: string; text: string }) {
  return (
    <div className="definition">
      <strong>{term}</strong>
      <span>{text}</span>
    </div>
  );
}

// ── DataTable ───────────────────────────────────────────

export function DataTable<T>({ loading, empty, rows, renderRow }: { loading: boolean; empty: string; rows: T[]; renderRow: (row: T, index: number) => ReactNode }) {
  if (loading) return <EmptyText text="Loading..." />;
  if (rows.length === 0) return <EmptyText text={empty} />;
  return <div className="record-list">{rows.map(renderRow)}</div>;
}

export function EmptyText({ text }: { text: string }) {
  return <div className="empty-text">{text}</div>;
}

// ── Panel ───────────────────────────────────────────────

export function Panel({ className, children, ...rest }: { className?: string; children: ReactNode }) {
  return <section className={`panel${className ? ` ${className}` : ''}`} {...rest}>{children}</section>;
}

export function PanelHead({ label, status, children }: { label?: string; status?: StatusState; children?: ReactNode }) {
  return (
    <div className="panel-head">
      <div>
        {label ? <h2>{label}</h2> : null}
        {children}
      </div>
      {status ? <StatusPill status={status} /> : null}
    </div>
  );
}

// ── Badge ───────────────────────────────────────────────

export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'err' | 'info' | 'muted'; children: ReactNode }) {
  return <span className={`badge${tone ? ` badge-${tone}` : ''}`}>{children}</span>;
}

// ── Button ──────────────────────────────────────────────

export function Button({
  children, variant, size, disabled, type, onClick, title,
}: {
  children: ReactNode;
  variant?: 'ghost' | 'danger' | 'primary';
  size?: 'tiny';
  disabled?: boolean;
  type?: 'button' | 'submit';
  onClick?: () => void;
  title?: string;
}) {
  const cls = [
    variant === 'danger' ? 'btn-danger' : variant === 'ghost' ? 'ghost-btn' : variant === 'primary' ? 'btn' : 'tiny-btn',
    size === 'tiny' ? 'tiny-btn' : '',
  ].filter(Boolean).join(' ');
  return <button className={cls} type={type ?? 'button'} disabled={disabled} onClick={onClick} title={title}>{children}</button>;
}

// ── Toolbar ─────────────────────────────────────────────

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function ToolbarToggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="toolbar-toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ── RefreshQueryButton ──────────────────────────────────

export function RefreshQueryButton({ queryKey }: { queryKey: unknown[] }) {
  const queryClient = useQueryClient();
  return (
    <Button variant="ghost" onClick={() => queryClient.invalidateQueries({ queryKey })}>
      <RefreshCcw size={14} /> refresh
    </Button>
  );
}

// ── Formatting helpers ──────────────────────────────────

export function formatDate(value: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatTime(value: string | undefined): string {
  if (!value) return '--:--:--';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0s';
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}
