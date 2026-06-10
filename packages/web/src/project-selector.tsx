import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, Folder, FolderOpen, Home, Star, X } from 'lucide-react';
import { getJson, postJson, deleteJson, setCurrentProjectId } from './api/index.js';
import type { ProjectBinding, ProjectBrowseResponse, ProjectListResponse } from './api/types.js';

interface ProjectSelectorProps {
  workspaceRoot: string;
  onChange: (path: string) => void;
  defaultWorkspace: string;
}

export function ProjectSelector({ workspaceRoot, onChange, defaultWorkspace }: ProjectSelectorProps) {
  const queryClient = useQueryClient();
  const selectorRef = useRef<HTMLDivElement>(null);
  const [pickerFeedback, setPickerFeedback] = useState('');
  const [bindName, setBindName] = useState('');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [browserPlacement, setBrowserPlacement] = useState<'up' | 'down'>('down');

  const { data } = useQuery({
    queryKey: ['projects'],
    queryFn: () => getJson<ProjectListResponse>('/projects'),
    staleTime: 30_000,
  });
  const browseTarget = browsePath || workspaceRoot || defaultWorkspace;
  const browse = useQuery({
    queryKey: ['projects-browse', browseTarget],
    queryFn: () => getJson<ProjectBrowseResponse>(`/projects/browse?path=${encodeURIComponent(browseTarget)}`),
    enabled: browserOpen,
    staleTime: 10_000,
    retry: false,
  });

  const projects = data?.projects ?? [];
  const currentProject = projects.find(p => p.workspacePath === workspaceRoot);

  const updateBrowserPlacement = useCallback(() => {
    const rect = selectorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const panelHeight = 360;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    setBrowserPlacement(spaceBelow < panelHeight && spaceAbove > spaceBelow ? 'up' : 'down');
  }, []);

  useLayoutEffect(() => {
    if (!browserOpen) return;
    updateBrowserPlacement();
    window.addEventListener('resize', updateBrowserPlacement);
    window.addEventListener('scroll', updateBrowserPlacement, true);
    return () => {
      window.removeEventListener('resize', updateBrowserPlacement);
      window.removeEventListener('scroll', updateBrowserPlacement, true);
    };
  }, [browserOpen, updateBrowserPlacement]);

  // Sync projectId header whenever workspace changes to a known project
  useEffect(() => {
    if (currentProject) {
      setCurrentProjectId(currentProject.projectId);
    } else {
      setCurrentProjectId(undefined);
    }
  }, [currentProject, workspaceRoot]);

  const handlePickFolder = useCallback(() => {
    setBrowserOpen(open => !open);
    setBrowsePath(prev => prev || workspaceRoot || defaultWorkspace);
    setPickerFeedback('');
    window.requestAnimationFrame(updateBrowserPlacement);
  }, [workspaceRoot, defaultWorkspace, updateBrowserPlacement]);

  const handleBindProject = useCallback(async () => {
    if (!workspaceRoot.trim()) return;
    const name = bindName.trim() || undefined;
    try {
      const project: ProjectBinding = await postJson('/projects/bind', {
        workspacePath: workspaceRoot.trim(),
        displayName: name,
      });
      setCurrentProjectId(project.projectId);
      setBindName('');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    } catch (e: any) {
      setPickerFeedback(e.message);
    }
  }, [workspaceRoot, bindName, queryClient]);

  const handleUnbind = useCallback(async (projectId: string) => {
    try {
      await deleteJson(`/projects/${projectId}`);
      setCurrentProjectId(undefined);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    } catch { /* ignore */ }
  }, [queryClient]);

  const handleSelectProject = useCallback((project: ProjectBinding) => {
    onChange(project.workspacePath);
    setCurrentProjectId(project.projectId);
    setBrowserOpen(false);
    // Touch lastUsed
    postJson(`/projects/${project.projectId}/touch`, {}).catch(() => {});
  }, [onChange]);

  const handleUseBrowsePath = useCallback((path: string) => {
    onChange(path);
    setPickerFeedback(`Selected ${path}`);
    setBrowserOpen(false);
  }, [onChange]);

  return (
    <div className="project-selector" ref={selectorRef}>
      <div className="project-selector-row">
        <Folder size={13} />
        <input
          aria-label="Execution directory"
          list="workspace-suggestions"
          value={workspaceRoot}
          onChange={e => onChange(e.target.value)}
          placeholder={defaultWorkspace || 'cwd'}
          className="exec-dir-input"
        />
        <button
          type="button"
          className="ghost-btn project-pick-btn"
          title="Browse local folders"
          onClick={handlePickFolder}
        >
          <FolderOpen size={13} />
        </button>
        {workspaceRoot && workspaceRoot !== defaultWorkspace && (
          <button type="button" className="ghost-btn exec-dir-reset" title="Reset to default workspace"
            onClick={() => onChange('')}>
            ↺ default
          </button>
        )}
        <datalist id="workspace-suggestions">
          {defaultWorkspace && <option value={defaultWorkspace} />}
          {defaultWorkspace && <option value={defaultWorkspace.replace(/\/[^/]+$/, '')} />}
          {projects.map(p => <option key={p.projectId} value={p.workspacePath} />)}
        </datalist>
      </div>

      {browserOpen && (
        <div className="project-browser" data-placement={browserPlacement}>
          <div className="project-browser-head">
            <button
              type="button"
              className="ghost-btn"
              disabled={!browse.data?.parent}
              onClick={() => browse.data?.parent && setBrowsePath(browse.data.parent)}
              title="Parent directory"
            >
              <ArrowUp size={12} />
            </button>
            <input
              value={browseTarget}
              onChange={event => setBrowsePath(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') setBrowsePath((event.target as HTMLInputElement).value);
              }}
              className="project-browser-path"
              spellCheck={false}
            />
            <button
              type="button"
              className="ghost-btn project-use-btn"
              disabled={browse.isError || browse.isLoading}
              onClick={() => browse.data?.path && handleUseBrowsePath(browse.data.path)}
            >
              <Check size={12} /> use
            </button>
          </div>
          <div className="project-browser-roots">
            {browse.data?.roots.map(root => (
              <button
                key={root.label}
                type="button"
                className="project-root-chip"
                title={root.path}
                onClick={() => setBrowsePath(root.path)}
              >
                {root.label === 'home' ? <Home size={11} /> : null}
                {root.label}
              </button>
            ))}
          </div>
          {browse.isLoading ? (
            <div className="project-picker-feedback">Loading folders...</div>
          ) : browse.isError ? (
            <div className="project-picker-feedback error">{String((browse.error as Error).message ?? browse.error)}</div>
          ) : (
            <div className="project-browser-list">
              {browse.data?.entries.length === 0 ? (
                <span className="project-empty">No subfolders</span>
              ) : browse.data?.entries.map(entry => (
                <button
                  key={entry.path}
                  type="button"
                  className={`project-browser-item${entry.hidden ? ' hidden' : ''}`}
                  title={entry.path}
                  onClick={() => setBrowsePath(entry.path)}
                >
                  <Folder size={12} />
                  <span>{entry.name}</span>
                </button>
              ))}
            </div>
          )}

          <div className="project-browser-footer">
            {workspaceRoot.trim() && !currentProject && (
              <div className="project-bind-row">
                <input
                  type="text"
                  className="project-bind-name"
                  placeholder={workspaceRoot.split('/').pop() ?? 'project name'}
                  value={bindName}
                  onChange={e => setBindName(e.target.value)}
                />
                <button type="button" className="ghost-btn project-bind-btn" onClick={handleBindProject}>
                  <Star size={12} /> bind project
                </button>
              </div>
            )}
            {currentProject && (
              <div className="project-bound-badge">
                <Check size={12} />
                <span>{currentProject.displayName}</span>
                <button type="button" className="ghost-btn project-unbind-btn"
                  title="Unbind project"
                  onClick={() => handleUnbind(currentProject.projectId)}>
                  <X size={12} />
                </button>
              </div>
            )}

            {projects.length > 0 && (
              <div className="project-recent">
                <span className="project-recent-label">projects</span>
                {projects
                  .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
                  .slice(0, 6)
                  .map(p => (
                    <button
                      key={p.projectId}
                      type="button"
                      className={`project-chip${p.workspacePath === workspaceRoot ? ' active' : ''}`}
                      title={p.workspacePath}
                      onClick={() => handleSelectProject(p)}
                    >
                      {p.displayName}
                    </button>
                  ))}
              </div>
            )}

            {pickerFeedback && (
              <div className="project-picker-feedback">{pickerFeedback}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
