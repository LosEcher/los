import { useState } from 'react';
import { CheckCircle2, Diff, FileArchive, RotateCcw, ShieldCheck } from 'lucide-react';

import type { WorkItemProjection } from '../api/index.js';
import { formatDate } from '../ui.js';
import { tt, useI18n } from '../i18n';

function WorkspaceDiff({ workspaceId, onFilesLoaded }: { workspaceId: string; onFilesLoaded?: (paths: string[]) => void }) {
  const { t } = useI18n();
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
      onFilesLoaded?.(parseDiffFiles(data.diff || '').map(file => file.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (!expanded) {
    return <button className="ghost-btn diff-expand-btn" type="button" onClick={() => { setExpanded(true); loadDiff(); }}>
      <Diff size={14} /> {t('work.review.viewDiff')}
    </button>;
  }

  if (loading) return <p className="diff-loading">{t('work.review.loadingDiff')}</p>;
  if (error) return <p className="diff-error">{t('work.review.diffUnavailable', { error })}</p>;
  if (!diff) return <p className="diff-empty">{t('work.review.diffEmpty')}</p>;

  const files = parseDiffFiles(diff);
  const fileCount = files.length;
  const totalLines = diff.split('\n').length;

  return (
    <div className="workspace-diff">
      <div className="diff-summary">
        <span>{fileCount === 1 ? t('work.review.fileChanged') : t('work.review.filesChanged', { count: fileCount })}</span>
        <span>{totalLines === 1 ? t('work.review.line') : t('work.review.lines', { count: totalLines })}</span>
        <button className="ghost-btn" type="button" onClick={() => setShowAll(!showAll)}>
          {showAll ? t('work.review.collapseAll') : t('work.review.expandAll')}
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
  return [...lines.slice(0, MAX_PREVIEW), tt('work.review.moreLines', { count: lines.length - MAX_PREVIEW })];
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
  onDecision: (decision: 'accepted' | 'revision_requested', reason: string, dirtyPaths: string[]) => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [dirtyPaths, setDirtyPaths] = useState<string[]>([]);
  const canDecide = Boolean(item.availableActions.reviewResult);
  const collectDiffFiles = (paths: string[]) => {
    setDirtyPaths(current => Array.from(new Set([...current, ...paths])));
  };
  const decide = (decision: 'accepted' | 'revision_requested') => {
    onDecision(decision, reason, decision === 'accepted' ? dirtyPaths : []);
  };
  return (
    <section className="work-review-panel">
      <header><div><span className="eyebrow">{t('work.review.eyebrow')}</span><h3>{t('work.review.title')}</h3></div><ShieldCheck size={18} /></header>
      <div className="verification-records">
        {item.verificationRecords.length === 0 ? <p className="review-empty">{t('work.review.noRecords')}</p> : item.verificationRecords.map(record => (
          <article className="verification-record" key={record.id}>
            <span className={`review-status ${record.status}`}>{record.status}</span>
            <div><strong>{record.checkName}</strong><small>{record.command ?? record.assertion ?? record.reviewer ?? record.kind}</small></div>
            <p>{record.outputSummary ?? record.error ?? record.skipReason ?? t('work.review.noOutput')}</p>
          </article>
        ))}
      </div>
      <div className="workspace-evidence">
        {item.changes.workspaces.length === 0 ? <p className="review-empty">{t('work.review.noWorkspace')}</p> : item.changes.workspaces.map(workspace => (
          <WorkspaceEvidence key={workspace.workspaceId} workspace={workspace} onDiffFiles={collectDiffFiles} />
        ))}
      </div>
      {item.changes.resultReview ? (
        <div className="result-review-record"><strong>{item.changes.resultReview.decision.replaceAll('_', ' ')}</strong><span>{item.changes.resultReview.reason}</span><small>{item.changes.resultReview.actor} · {formatDate(item.changes.resultReview.decidedAt)}</small></div>
      ) : null}
      {canDecide ? (
        <div className="result-review-actions">
          <label><span>{t('work.review.decisionReason')}</span><input value={reason} onChange={event => setReason(event.target.value)} placeholder={t('work.review.decisionPlaceholder')} /></label>
          <div>
            <button className="ghost-btn" type="button" disabled={pending || !reason.trim()} onClick={() => decide('revision_requested')}><RotateCcw size={14} /> {t('work.review.requestRevision')}</button>
            <button className="btn" type="button" disabled={pending || !reason.trim()} onClick={() => decide('accepted')}><CheckCircle2 size={14} /> {t('work.review.acceptResult')}</button>
          </div>
        </div>
      ) : null}
      {error ? <div className="daily-error">{t('work.review.failed', { error: String(error) })}</div> : null}
    </section>
  );
}

function WorkspaceEvidence({
  workspace,
  onDiffFiles,
}: {
  workspace: WorkItemProjection['changes']['workspaces'][number];
  onDiffFiles: (paths: string[]) => void;
}) {
  const { t } = useI18n();
  const [backupState, setBackupState] = useState<'idle' | 'pending' | 'created' | 'error'>('idle');
  const [backupError, setBackupError] = useState<string | null>(null);

  async function createBackup() {
    setBackupState('pending');
    setBackupError(null);
    try {
      const res = await fetch(`/managed-workspaces/${encodeURIComponent(workspace.workspaceId)}/backup`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}`);
      setBackupState('created');
    } catch (err) {
      setBackupState('error');
      setBackupError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <article className="workspace-record" key={workspace.workspaceId}>
      <FileArchive size={16} />
      <div><strong>{workspace.workspaceId}</strong><small>{workspace.status} · {t('work.review.base', { rev: workspace.baseRevision })}</small></div>
      <code>{workspace.backupArtifactId ?? t('work.review.backupRequired')}</code>
      {workspace.backupArtifactId ? null : (
        <button className="ghost-btn" type="button" disabled={backupState === 'pending'} onClick={() => void createBackup()}>
          <FileArchive size={14} /> {backupState === 'pending' ? t('work.review.creatingBackup') : backupState === 'created' ? t('work.review.backupCreated') : t('work.review.createBackup')}
        </button>
      )}
      {backupState === 'error' && backupError ? <p className="diff-error">{t('work.review.backupFailed', { error: backupError })}</p> : null}
      <WorkspaceDiff workspaceId={workspace.workspaceId} onFilesLoaded={onDiffFiles} />
    </article>
  );
}
