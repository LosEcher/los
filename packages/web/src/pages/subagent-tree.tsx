/**
 * SubagentTree — recursive child-agent lineage for one session (Phase 4).
 *
 * Consumes GET /sessions/:id/subagents: run specs whose parent_run_spec_id
 * chain descends from the session's run specs, each with child.agent.*
 * lifecycle status, token usage / cost aggregated from the child session, and
 * duration. Click a node to jump to its child session. Design reference: DSH
 * ui-subagent catalog tree pattern.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import { getJson } from '../api/index.js';
import { useI18n } from '../i18n';

export interface SubagentUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
}

export interface SubagentTreeNode {
  runSpecId: string;
  sessionId: string;
  status: string;
  eventStatus: 'started' | 'completed' | 'failed' | 'killed' | null;
  provider?: string;
  model?: string;
  promptPreview: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  estimatedCostUsd: number;
  usage: SubagentUsage;
  children: SubagentTreeNode[];
}

export interface SessionSubagentsResponse {
  sessionId: string;
  roots: Array<{ runSpecId: string; status: string }>;
  tree: SubagentTreeNode[];
}

export function SubagentTree({
  sessionId,
  onSelectSession,
}: {
  sessionId: string | null;
  onSelectSession?: (id: string) => void;
}) {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['session-subagents', sessionId],
    queryFn: () => getJson<SessionSubagentsResponse>(
      `/sessions/${encodeURIComponent(sessionId!)}/subagents`,
    ),
    enabled: Boolean(sessionId),
    refetchInterval: 30_000,
  });

  if (!sessionId) return null;
  const data = query.data;
  const hasTree = data && data.tree.length > 0 && data.tree.some(node => node.children.length > 0);

  return (
    <section className="subagent-tree" aria-label={t('assets.subagents.sectionAria')}>
      <div className="subagent-tree-head">
        <GitBranch size={14} />
        <strong>{t('assets.subagents.title')}</strong>
        {data ? (
          <span className="subagent-tree-count">
            {t('assets.subagents.count', { count: String(countNodes(data.tree)) })}
          </span>
        ) : null}
      </div>
      {query.isLoading ? <p className="timeline-hint">{t('common.loading')}</p> : null}
      {query.error ? (
        <p className="topology-error" role="alert">{t('assets.subagents.loadError', { error: String(query.error) })}</p>
      ) : null}
      {data && data.tree.length === 0 ? (
        <p className="timeline-hint">{t('assets.subagents.empty')}</p>
      ) : null}
      {data && data.tree.length > 0 ? (
        <ul className="subagent-tree-list">
          {data.tree.map(node => <TreeNode key={node.runSpecId} node={node} depth={0} onSelectSession={onSelectSession} />)}
        </ul>
      ) : null}
      {data && !hasTree && data.tree.length > 0 ? (
        <p className="timeline-hint">{t('assets.subagents.noChildren')}</p>
      ) : null}
    </section>
  );
}

function TreeNode({
  node,
  depth,
  onSelectSession,
}: {
  node: SubagentTreeNode;
  depth: number;
  onSelectSession?: (id: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <li className="subagent-node">
      <div className={`subagent-node-row${hasChildren ? ' is-branch' : ''}`} style={{ paddingLeft: `${depth * 18 + 6}px` }}>
        {hasChildren ? (
          <button
            type="button"
            className="subagent-node-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={expanded ? t('assets.subagents.collapse') : t('assets.subagents.expand')}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="subagent-node-toggle-spacer" />
        )}
        <a
          href="#sessions"
          className="subagent-node-link"
          title={node.promptPreview}
          onClick={() => jumpToSession(node.sessionId, onSelectSession)}
        >
          <span className={`subagent-status-dot is-${node.eventStatus ?? node.status}`} />
          <code>{node.runSpecId.slice(0, 20)}</code>
        </a>
        <span className={`status-text ${node.status}`}>{node.status}</span>
        {node.eventStatus ? <span className={`subagent-event is-${node.eventStatus}`}>{node.eventStatus}</span> : null}
        {node.model ? <span className="subagent-model">{node.provider}/{node.model}</span> : null}
        <span className="subagent-meta">
          {node.durationMs !== null ? formatMs(node.durationMs) : '—'}
          {node.usage.totalTokens > 0 ? ` · ${node.usage.totalTokens.toLocaleString()} tok` : ''}
          {node.estimatedCostUsd > 0 ? ` · $${node.estimatedCostUsd.toFixed(4)}` : ''}
        </span>
      </div>
      {hasChildren && expanded ? (
        <ul className="subagent-tree-list">
          {node.children.map(child => (
            <TreeNode key={child.runSpecId} node={child} depth={depth + 1} onSelectSession={onSelectSession} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function countNodes(nodes: readonly SubagentTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function jumpToSession(sessionId: string, onSelectSession?: (id: string) => void) {
  if (onSelectSession) {
    onSelectSession(sessionId);
    return;
  }
  // Fallback for cross-page navigation: persist and let Sessions pick it up.
  sessionStorage.setItem('los.activity.session', sessionId);
}
