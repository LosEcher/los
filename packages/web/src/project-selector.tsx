import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, FolderOpen, Star, X, Check } from 'lucide-react';
import { getJson, postJson, deleteJson, setCurrentProjectId } from './api/index.js';
import type { ProjectBinding, ProjectListResponse } from './api/types.js';

interface ProjectSelectorProps {
  workspaceRoot: string;
  onChange: (path: string) => void;
  defaultWorkspace: string;
}

export function ProjectSelector({ workspaceRoot, onChange, defaultWorkspace }: ProjectSelectorProps) {
  const queryClient = useQueryClient();
  const [pickerFeedback, setPickerFeedback] = useState('');
  const [bindName, setBindName] = useState('');

  const { data } = useQuery({
    queryKey: ['projects'],
    queryFn: () => getJson<ProjectListResponse>('/projects'),
    staleTime: 30_000,
  });

  const projects = data?.projects ?? [];
  const currentProject = projects.find(p => p.workspacePath === workspaceRoot);

  // Sync projectId header whenever workspace changes to a known project
  useEffect(() => {
    if (currentProject) {
      setCurrentProjectId(currentProject.projectId);
    } else {
      setCurrentProjectId(undefined);
    }
  }, [currentProject, workspaceRoot]);

  const handlePickFolder = useCallback(async () => {
    try {
      // File System Access API — Chromium only
      const handle = await (
        window as unknown as { showDirectoryPicker: () => Promise<{ name: string }> }
      ).showDirectoryPicker();
      setPickerFeedback(`Selected: ${handle.name}`);
      // Pre-fill if the input is empty, using common parent paths
      if (!workspaceRoot.trim()) {
        const parentGuess = defaultWorkspace.replace(/\/[^/]+$/, '');
        const guessed = `${parentGuess}/${handle.name}`;
        onChange(guessed);
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return; // user cancelled
      setPickerFeedback('Folder picker not supported in this browser');
    }
  }, [workspaceRoot, defaultWorkspace, onChange]);

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
    // Touch lastUsed
    postJson(`/projects/${project.projectId}/touch`, {}).catch(() => {});
  }, [onChange]);

  return (
    <div className="project-selector">
      <div className="project-selector-row">
        <Folder size={13} />
        <input
          list="workspace-suggestions"
          value={workspaceRoot}
          onChange={e => onChange(e.target.value)}
          placeholder={defaultWorkspace || 'cwd'}
          className="exec-dir-input"
        />
        <button
          type="button"
          className="ghost-btn project-pick-btn"
          title="Pick folder (Chrome/Edge)"
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

      {/* Bind / status row */}
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

      {/* Recent projects */}
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
  );
}
