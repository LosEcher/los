import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCcw } from 'lucide-react';

export type StatusState = 'live' | 'partial' | 'reserved';

export function StatusPill({ status }: { status: StatusState }) {
  return <span className={`status-pill ${status}`}>{status}</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

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

export function DataTable<T>({ loading, empty, rows, renderRow }: { loading: boolean; empty: string; rows: T[]; renderRow: (row: T, index: number) => ReactNode }) {
  if (loading) return <EmptyText text="Loading..." />;
  if (rows.length === 0) return <EmptyText text={empty} />;
  return <div className="record-list">{rows.map(renderRow)}</div>;
}

export function EmptyText({ text }: { text: string }) {
  return <div className="empty-text">{text}</div>;
}

export function RefreshQueryButton({ queryKey }: { queryKey: unknown[] }) {
  const queryClient = useQueryClient();
  return (
    <button className="ghost-btn" type="button" onClick={() => queryClient.invalidateQueries({ queryKey })}>
      <RefreshCcw size={14} /> refresh
    </button>
  );
}

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
