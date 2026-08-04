import { useState } from 'react';
import { CheckCircle2, Diff, FileArchive, RotateCcw, ShieldCheck } from 'lucide-react';

import type { WorkItemProjection } from '../api/index.js';
import { getJson, postJson } from '../api/index.js';
import { buildSideBySideRows, collapseLargeHunks, parseDiffFileLines } from '../diff-parse.mjs';
import type { DiffLine, ParsedDiffFile } from '../diff-parse.mjs';
import { formatDate } from '../ui.js';
import { tt, useI18n } from '../i18n';

type DiffViewMode = 'unified' | 'side';

function WorkspaceDiff({ workspaceId, onFilesLoaded }: { workspaceId: string; onFilesLoaded?: (paths: string[]) => void }) {
  const { t } = useI18n();
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<DiffViewMode>('unified');

  async function loadDiff() {
    if (diff !== null || loading) return;
    setLoading(true);
    try {
      const data = await getJson<{ diff: string }>(`/managed-workspaces/${encodeURIComponent(workspaceId)}/diff`);
      setDiff(data.diff || '');
      onFilesLoaded?.(parseDiffFileLines(data.diff || '').map(file => file.path));
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

  const files = parseDiffFileLines(diff);
  const fileCount = files.length;
  const totalLines = diff.split('\n').length;

  return (
    <div className="workspace-diff">
      <div className="diff-summary">
        <span>{fileCount === 1 ? t('work.review.fileChanged') : t('work.review.filesChanged', { count: fileCount })}</span>
        <span>{totalLines === 1 ? t('work.review.line') : t('work.review.lines', { count: totalLines })}</span>
        <span className="diff-view-switch" role="group" aria-label={t('work.review.viewMode')}>
          <button
            type="button"
            className={view === 'unified' ? 'active' : ''}
            onClick={() => setView('unified')}
          >{t('work.review.viewUnified')}</button>
          <button
            type="button"
            className={view === 'side' ? 'active' : ''}
            onClick={() => setView('side')}
          >{t('work.review.viewSideBySide')}</button>
        </span>
        <button className="ghost-btn" type="button" onClick={() => setShowAll(!showAll)}>
          {showAll ? t('work.review.collapseAll') : t('work.review.expandAll')}
        </button>
      </div>
      <div className="diff-files">
        {files.map((file, fi) => (
          <DiffFile key={`${file.path}-${fi}`} file={file} view={view} expanded={showAll} />
        ))}
      </div>
    </div>
  );
}

interface DiffFileProps { file: ParsedDiffFile; view: DiffViewMode; expanded: boolean }

function DiffFile({ file, view, expanded }: DiffFileProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(expanded);
  const [showAllLines, setShowAllLines] = useState(false);
  const collapsed = file.lines.length > DIFF_PREVIEW_LIMIT && !showAllLines;
  const lines = collapsed ? collapseLargeHunks(file, DIFF_PREVIEW_LIMIT).lines : file.lines;

  return (
    <details className="diff-file" open={open} onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="diff-file-header">
        <strong>{file.path}{file.isNew ? ` (${t('work.review.newFile')})` : file.isDeleted ? ` (${t('work.review.deletedFile')})` : ''}</strong>
        <span className="diff-stat">
          <span className="diff-added">+{file.added}</span>
          <span className="diff-removed">-{file.removed}</span>
        </span>
      </summary>
      {file.isBinary ? (
        <pre className="diff-content"><span className="diff-meta">{t('work.review.binaryDiff')}</span></pre>
      ) : view === 'side' ? (
        <SideBySideDiff lines={lines} />
      ) : (
        <UnifiedDiff lines={lines} />
      )}
      {collapsed ? (
        <button className="ghost-btn diff-more-btn" type="button" onClick={() => setShowAllLines(true)}>
          {t('work.review.moreLines', { count: file.lines.length - DIFF_PREVIEW_LIMIT })}
        </button>
      ) : null}
    </details>
  );
}

const DIFF_PREVIEW_LIMIT = 60;

function UnifiedDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="diff-content">{lines.map((line, i) => (
      <span key={i} className={`diff-line-row ${lineClass(line)}`}>
        <span className="diff-line-num">{line.oldLine ?? ''}</span>
        <span className="diff-line-num">{line.newLine ?? ''}</span>
        <span className="diff-line-text">{line.text}{'\n'}</span>
      </span>
    ))}</pre>
  );
}

function SideBySideDiff({ lines }: { lines: DiffLine[] }) {
  const rows = buildSideBySideRows(lines);
  return (
    <div className="diff-content diff-side-grid">{rows.map((row, i) => (
      <div key={i} className={`diff-side-row${row.full ? ' full' : ''}`}>
        {row.full ? (
          <span className={`diff-line-row ${lineClass(row.left!)}`}>
            <span className="diff-line-num">{row.left!.oldLine ?? ''}</span>
            <span className="diff-line-num">{row.left!.newLine ?? ''}</span>
            <span className="diff-line-text">{row.left!.text}{'\n'}</span>
          </span>
        ) : (
          <>
            <SideCell side="left" line={row.left} />
            <SideCell side="right" line={row.right} />
          </>
        )}
      </div>
    ))}</div>
  );
}

function SideCell({ side, line }: { side: 'left' | 'right'; line: DiffLine | null }) {
  if (!line) return <span className="diff-side-cell diff-empty" />;
  return (
    <span className={`diff-side-cell ${lineClass(line)}`}>
      <span className="diff-line-num">{side === 'left' ? line.oldLine ?? '' : line.newLine ?? ''}</span>
      <span className="diff-line-text">{line.text}{'\n'}</span>
    </span>
  );
}

function lineClass(line: DiffLine): string {
  if (line.type === 'add') return 'diff-add';
  if (line.type === 'del') return 'diff-del';
  if (line.type === 'hunk') return 'diff-hunk';
  if (line.type === 'meta') return 'diff-meta';
  return 'diff-ctx';
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
      await postJson(`/managed-workspaces/${encodeURIComponent(workspace.workspaceId)}/backup`, {});
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
