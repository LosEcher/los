import { useState } from 'react';
import { CheckCircle2, FileArchive, RotateCcw, ShieldCheck } from 'lucide-react';

import type { WorkItemProjection } from '../api/index.js';
import { formatDate } from '../ui.js';

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
  const canDecide = item.nextAction === 'review_changes';
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
