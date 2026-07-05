/**
 * Workspace files panel — browse and preview files from the agent's workspace.
 * Opens as a collapsible third column or overlay panel.
 */
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Folder, File, FileCode, FileText, FileImage, X, RefreshCw } from 'lucide-react';
import { getJson } from './api';

type FileEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
};

type BrowseResult = {
  path: string;
  entries: FileEntry[];
};

export function FilesPanel({
  workspaceRoot,
  open,
  onClose,
}: {
  workspaceRoot: string;
  open: boolean;
  onClose: () => void;
}) {
  const [currentPath, setCurrentPath] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const browse = useQuery({
    queryKey: ['workspace-browse', workspaceRoot, currentPath],
    queryFn: () => getJson<BrowseResult>(`/workspace/browse?path=${encodeURIComponent(currentPath || workspaceRoot)}`),
    enabled: open && Boolean(workspaceRoot),
    refetchInterval: 15_000,
  });

  const filePreview = useQuery({
    queryKey: ['workspace-file', previewPath],
    queryFn: () => getJson<{ path: string; content: string; size: number }>(`/workspace/file?path=${encodeURIComponent(previewPath ?? '')}`),
    enabled: Boolean(previewPath),
  });

  if (!open) return null;

  function fileIcon(name: string) {
    if (name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.js') || name.endsWith('.jsx')) return <FileCode size={13} />;
    if (name.endsWith('.json') || name.endsWith('.yaml') || name.endsWith('.yml') || name.endsWith('.toml')) return <FileCode size={13} />;
    if (name.endsWith('.md') || name.endsWith('.txt') || name.endsWith('.log')) return <FileText size={13} />;
    if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.svg')) return <FileImage size={13} />;
    return <File size={13} />;
  }

  return (
    <aside className="files-panel">
      <div className="files-panel-head">
        <h3>Workspace</h3>
        <div className="files-panel-actions">
          <button className="ghost-btn" type="button" onClick={() => browse.refetch()}>
            <RefreshCw size={13} />
          </button>
          <button className="ghost-btn" type="button" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="files-panel-path">
        <code>{currentPath || workspaceRoot || '...'}</code>
        {currentPath && (
          <button className="ghost-btn" type="button" onClick={() => {
            const parts = currentPath.split('/');
            parts.pop();
            setCurrentPath(parts.join('/'));
          }}>
            ↑ up
          </button>
        )}
      </div>
      <div className="files-panel-list">
        {browse.data?.entries.map(entry => (
          <div
            key={entry.path}
            className={`files-entry ${entry.type}`}
            onClick={() => {
              if (entry.type === 'directory') {
                setCurrentPath(entry.path);
              } else {
                setPreviewPath(previewPath === entry.path ? null : entry.path);
              }
            }}
          >
            {entry.type === 'directory' ? <Folder size={13} /> : fileIcon(entry.name)}
            <span className="files-entry-name">{entry.name}</span>
            {entry.size !== undefined && (
              <span className="files-entry-size">{formatFileSize(entry.size)}</span>
            )}
          </div>
        ))}
      </div>
      {previewPath && filePreview.data && (
        <div className="files-preview">
          <div className="files-preview-head">
            <code>{previewPath}</code>
            <button className="ghost-btn" type="button" onClick={() => setPreviewPath(null)}>
              <X size={12} />
            </button>
          </div>
          <pre className="files-preview-content">
            {(filePreview.data.content ?? '').slice(0, 4000)}
          </pre>
        </div>
      )}
    </aside>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
