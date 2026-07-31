import { useState } from 'react';
import { CheckCircle2, Diff, FileArchive, RotateCcw, ShieldCheck } from 'lucide-react';

import type { WorkItemProjection } from '../api/index.js';
import { formatDate } from '../ui.js';

function WorkspaceDiff({ workspaceId }: { workspaceId: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  async function loadDiff() {
    if (diff !== null || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/managed-workspaces/${encodeURIComponent(workspaceId)}/diff`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json() as { diff: string };
      setDiff(data.diff || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (!expanded) {
    return <button className="ghost-btn diff-expand-btn" type="button" onClick={() => { setExpanded(true); loadDiff(); }}>
      <Diff size={14} /> View diff
    </button>;
  }

  if (loading) return <p className="diff-loading">Loading diff…</p>;
  if (error) return <p className="diff-error">Diff unavailable: {error}</p>;
  if (!diff) return <p className="diff-empty">No changes in this workspace.</p>;

  const files = parseDiffFiles(diff);
  const fileCount = files.length;
  const totalLines = diff.split('\n').length;

  return (
    <div className="workspace-diff">
      <div className="diff-summary">
        <span>{fileCount} file{fileCount !== 1 ? 's' : ''} changed</span>
        <span>{totalLines} line{totalLines !== 1 ? 's' : ''}</span>
        <button className="ghost-btn" type="button" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <div className="diff-files">
        {files.map((file, fi) => (
          <DiffFile key={`${file.path}-${fi}`} file={file} expanded={showAll} />
        ))}
      </div>
    </div>
  );
}

interface DiffFile { path: string; hunks: string[]; added: number; removed: number }

function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunkLines: string[] = [];

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) { current.hunks = finalizeHunks(hunkLines); files.push(current); }
      const pathMatch = line.match(/diff --git a\/(.*?) b\/(.*)/);
      current = { path: pathMatch?.[2] ?? pathMatch?.[1] ?? line, hunks: [], added: 0, removed: 0 };
      hunkLines = [line];
    } else if (current) {
      hunkLines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
      if (line.startsWith('-') && !line.startsWith('---')) current.removed++;
    }
  }
  if (current) { current.hunks = finalizeHunks(hunkLines); files.push(current); }
  return files;
}

function finalizeHunks(lines: string[]): string[] {
  const MAX_PREVIEW = 60;
  if (lines.length <= MAX_PREVIEW) return lines;
  return [...lines.slice(0, MAX_PREVIEW), `... (${lines.length - MAX_PREVIEW} more lines — expand to view)`];
}

function DiffFile({ file, expanded }: { file: DiffFile; expanded: boolean }) {
  const [open, setOpen] = useState(expanded);
  return (
    <details className="diff-file" open={open} onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="diff-file-header">
        <strong>{file.path}</strong>
        <span className="diff-stat">
          <span className="diff-added">+{file.added}</span>
          <span className="diff-removed">-{file.removed}</span>
        </span>
      </summary>
      <pre className="diff-content">{file.hunks.map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add'
          : line.startsWith('-') && !line.startsWith('---') ? 'diff-del'
          : line.startsWith('@@') ? 'diff-hunk'
          : line.startsWith('diff --git') ? 'diff-meta'
          : '';
        return <span key={i} className={cls}>{line}{'\n'}</span>;
      })}</pre>
    </details>
  );
}

export function WorkReviewPanel({
  item,
  pending,
  error,
  onDecision,
}: {
  item: WorkItemProjection;
  pending: boolean;
  error?: unknown;
  onDecision: (decision: 'accepted' | 'revision_requested', reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const canDecide = Boolean(item.availableActions.reviewResult);
  return (
    <section className="work-review-panel">
      <header><div><span className="eyebrow">Result review</span><h3>Verification and changes</h3></div><ShieldCheck size={18} /></header>
      <div className="verification-records">
        {item.verificationRecords.length === 0 ? <p className="review-empty">No verification records.</p> : item.verificationRecords.map(record => (
          <article className="verification-record" key={record.id}>
            <span className={`review-status ${record.status}`}>{record.status}</span>
            <div><strong>{record.checkName}</strong><small>{record.command ?? record.assertion ?? record.reviewer ?? record.kind}</small></div>
            <p>{record.outputSummary ?? record.error ?? record.skipReason ?? 'No output summary.'}</p>
          </article>
        ))}
      </div>
      <div className="workspace-evidence">
        {item.changes.workspaces.length === 0 ? <p className="review-empty">No managed workspace evidence.</p> : item.changes.workspaces.map(workspace => (
          <article className="workspace-record" key={workspace.workspaceId}>
            <FileArchive size={16} />
            <div><strong>{workspace.workspaceId}</strong><small>{workspace.status} · base {workspace.baseRevision}</small></div>
            <code>{workspace.backupArtifactId ?? 'backup required'}</code>
            <WorkspaceDiff workspaceId={workspace.workspaceId} />
          </article>
        ))}
      </div>
      {item.changes.resultReview ? (
        <div className="result-review-record"><strong>{item.changes.resultReview.decision.replaceAll('_', ' ')}</strong><span>{item.changes.resultReview.reason}</span><small>{item.changes.resultReview.actor} · {formatDate(item.changes.resultReview.decidedAt)}</small></div>
      ) : null}
      {canDecide ? (
        <div className="result-review-actions">
          <label><span>Decision reason</span><input value={reason} onChange={event => setReason(event.target.value)} placeholder="Evidence-based review decision" /></label>
          <div>
            <button className="ghost-btn" type="button" disabled={pending || !reason.trim()} onClick={() => onDecision('revision_requested', reason)}><RotateCcw size={14} /> Request revision</button>
            <button className="btn" type="button" disabled={pending || !reason.trim()} onClick={() => onDecision('accepted', reason)}><CheckCircle2 size={14} /> Accept result</button>
          </div>
        </div>
      ) : null}
      {error ? <div className="daily-error">Review failed: {String(error)}</div> : null}
    </section>
  );
}
