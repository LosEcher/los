import { Send, Square, Wrench, Zap, BookOpen } from 'lucide-react';
import { type FormEvent, useState, useRef, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProviderModelRoute, ProviderModelsResponse, RuntimeKind, ToolMode } from './api';
import { getJson } from './api';
import { RunField } from './chat-ui.js';
import { ProjectSelector } from './project-selector.js';
import { providerRoutesFromModels } from './chat-helpers.js';
import { ChatAdvancedSettings, type ChatAdvancedSettingsState } from './chat-advanced-settings.js';
import { useI18n } from './i18n';

// ── Slash commands ────────────────────────────────────

const SLASH_COMMANDS = [
  { cmd: '/clear', descKey: 'chat.slash.clear' },
  { cmd: '/debug', descKey: 'chat.slash.debug' },
  { cmd: '/retry', descKey: 'chat.slash.retry' },
  { cmd: '/abort', descKey: 'chat.slash.abort' },
  { cmd: '/files', descKey: 'chat.slash.files' },
  { cmd: '/skill ', descKey: 'chat.slash.skill' },
  { cmd: '/mode ', descKey: 'chat.slash.mode' },
  { cmd: '/provider ', descKey: 'chat.slash.provider' },
  { cmd: '/model ', descKey: 'chat.slash.model' },
];

type SkillPickerItem = {
  id: string;
  name: string;
  description: string;
  runMode: string;
  enabled: boolean;
  usageCount: number;
  metadata: Record<string, unknown>;
};

type SlashCommand = { cmd: string; descKey: string };

function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const lower = input.toLowerCase();
  return SLASH_COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(lower) || c.cmd.toLowerCase().includes(lower));
}

// ── Composer toolbar (Wave 3: split from the god component) ──

function ComposerToolbar(props: {
  selectedRoute: ProviderModelRoute | null;
  modelOptions: string[];
  runtimeKind: RuntimeKind | 'los';
  onRuntimeKindChange: (value: RuntimeKind | 'los') => void;
  grokRuntimeEnabled: boolean;
  provider: string;
  onProviderChange: (value: string) => void;
  providerOptions: Array<{ id: string; label: string }>;
  model: string;
  onModelChange: (value: string) => void;
  advancedState: ChatAdvancedSettingsState;
  onAdvancedChange: (patch: Partial<ChatAdvancedSettingsState>) => void;
  advancedCount: number;
  toolMode: ToolMode;
  onToolModeChange: (value: ToolMode) => void;
  workspaceRoot: string;
  onWorkspaceRootChange: (value: string) => void;
  defaultWorkspace: string;
}) {
  const { t } = useI18n();
  return (
    <div className="composer-toolbar" aria-label={t('chat.runChoicesAria')}>
      <span
        className={`route-dot ${props.selectedRoute?.ok ? 'ok' : 'partial'}`}
        title={props.selectedRoute?.baseUrl ?? props.selectedRoute?.error ?? t('chat.discoveryPending')}
      />
      <div className="composer-power-fields">
        <RunField label={t('chat.runtime')} title={t('chat.runtimeTitle')}>
          <Zap size={13} />
          <select value={props.runtimeKind} onChange={event => props.onRuntimeKindChange(event.target.value as RuntimeKind | 'los')}>
            <option value="los">{t('chat.agentLos')}</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
            {props.grokRuntimeEnabled || props.runtimeKind === 'grok' ? (
              <option value="grok" disabled={!props.grokRuntimeEnabled}>
                {props.grokRuntimeEnabled ? t('chat.grokExisting') : t('chat.grokUnavailable')}
              </option>
            ) : null}
          </select>
        </RunField>
        {props.runtimeKind === 'los' ? (
          <>
            <RunField label={t('chat.provider')} title={t('chat.providerTitle')}>
              {props.providerOptions.length > 0 ? (
                <select value={props.provider} onChange={event => { props.onProviderChange(event.target.value); props.onModelChange(''); }}>
                  {props.providerOptions.map(option => (
                    <option value={option.id} key={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={props.provider} onChange={event => { props.onProviderChange(event.target.value); props.onModelChange(''); }} placeholder={t('chat.providerId')} />
              )}
            </RunField>
            <RunField label={t('chat.model')} title={t('chat.modelTitle')}>
              {props.modelOptions.length > 0 ? (
                <select value={props.model} onChange={event => props.onModelChange(event.target.value)}>
                  {props.modelOptions.map(option => <option value={option} key={option}>{option}</option>)}
                </select>
              ) : (
                <input value={props.model} onChange={event => props.onModelChange(event.target.value)} placeholder={props.selectedRoute?.model ?? t('chat.providerDefault')} />
              )}
            </RunField>
          </>
        ) : (
          <span className="route-dot warn" title={t('chat.externalRuntime', { runtime: props.runtimeKind })} />
        )}
        <ChatAdvancedSettings
          state={props.advancedState}
          onChange={props.onAdvancedChange}
          advancedCount={props.advancedCount}
        />
      </div>
      {props.runtimeKind === 'los' ? (
        <RunField label={t('chat.toolsSkills')} title={t('chat.toolsSkillsTitle')}>
          <Wrench size={13} />
          <select value={props.toolMode} onChange={event => props.onToolModeChange(event.target.value as ToolMode)}>
            <option value="read-only">{t('chat.modeReadOnly')}</option>
            <option value="project-write">{t('chat.modeProjectWrite')}</option>
          </select>
        </RunField>
      ) : null}
      <RunField label={t('chat.executionDir')} title={t('chat.executionDirTitle', { default: props.defaultWorkspace || t('chat.loadingEllipsis') })} variant="group">
        <ProjectSelector
          workspaceRoot={props.workspaceRoot}
          onChange={props.onWorkspaceRootChange}
          defaultWorkspace={props.defaultWorkspace}
        />
      </RunField>
    </div>
  );
}

// ── Composer ──────────────────────────────────────────

export function ChatComposer(props: {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  running: boolean;

  provider: string;
  onProviderChange: (value: string) => void;
  providerOptions: Array<{ id: string; label: string }>;
  model: string;
  onModelChange: (value: string) => void;
  modelRoutes: ProviderModelsResponse | undefined;

  toolMode: ToolMode;
  onToolModeChange: (value: ToolMode) => void;

  runtimeKind: RuntimeKind | 'los';
  onRuntimeKindChange: (value: RuntimeKind | 'los') => void;
  grokRuntimeEnabled: boolean;

  workspaceRoot: string;
  onWorkspaceRootChange: (value: string) => void;
  defaultWorkspace: string;

  advancedState: ChatAdvancedSettingsState;
  onAdvancedChange: (patch: Partial<ChatAdvancedSettingsState>) => void;
  advancedCount: number;

  /** Skill names selected for the next send (manual invoke). */
  selectedSkillIds: string[];
  onSelectedSkillIdsChange: (ids: string[]) => void;

  /** When true, phone shell shows provider/runtime advanced controls. */
  debugMode?: boolean;
}) {
  const { t } = useI18n();
  const providerRoutes = providerRoutesFromModels(props.modelRoutes);
  const skillsQuery = useQuery({
    queryKey: ['skills', 'chat-picker'],
    queryFn: () => getJson<SkillPickerItem[]>('/skills?enabled=true'),
    staleTime: 30_000,
  });
  const invocableSkills = useMemo(() => {
    const list = skillsQuery.data ?? [];
    return list.filter(skill => {
      if (!skill.enabled) return false;
      if (skill.metadata?.userInvocable === false) return false;
      if (skill.metadata?.['user-invocable'] === false) return false;
      return true;
    });
  }, [skillsQuery.data]);
  const selectedRoute = providerRoutes.find(route => route.provider === props.provider) ?? providerRoutes[0] ?? null;
  const modelOptions = (() => {
    const ids = new Set<string>();
    if (selectedRoute?.model) ids.add(selectedRoute.model);
    for (const item of selectedRoute?.models ?? []) {
      if (item.id) ids.add(item.id);
    }
    return [...ids];
  })();

  // ── Slash command autocomplete ──
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const matches = matchCommands(props.prompt);
  const visible = showSlashMenu && matches.length > 0;

  const applySlash = useCallback((cmd: string) => {
    props.onPromptChange(cmd);
    setShowSlashMenu(false);
    setSlashIndex(0);
    textareaRef.current?.focus();
  }, [props.onPromptChange]);

  const toggleSkill = useCallback((name: string) => {
    const selected = props.selectedSkillIds;
    if (selected.includes(name)) {
      props.onSelectedSkillIdsChange(selected.filter(id => id !== name));
    } else {
      props.onSelectedSkillIdsChange([...selected, name]);
    }
  }, [props.selectedSkillIds, props.onSelectedSkillIdsChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!visible) return;
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      const match = matches[slashIndex];
      if (match) applySlash(match.cmd);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSlashIndex(i => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSlashIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Escape') {
      setShowSlashMenu(false);
    }
  };

  const handleChange = (value: string) => {
    props.onPromptChange(value);
    // `/skill name` → also pin skill for this send when name matches a registry skill
    const skillMatch = value.match(/^\/skill(?:s)?\s+(\S+)/i);
    if (skillMatch) {
      const name = skillMatch[1]!;
      if (invocableSkills.some(s => s.name === name) && !props.selectedSkillIds.includes(name)) {
        props.onSelectedSkillIdsChange([...props.selectedSkillIds, name]);
      }
    }
    if (value.startsWith('/') && !value.includes(' ')) {
      setShowSlashMenu(true);
      setSlashIndex(0);
    } else {
      setShowSlashMenu(false);
    }
  };

  return (
    <form
      className="composer"
      data-debug={props.debugMode ? 'true' : 'false'}
      onSubmit={props.onSubmit}
    >
      <ComposerToolbar
        selectedRoute={selectedRoute}
        modelOptions={modelOptions}
        runtimeKind={props.runtimeKind}
        onRuntimeKindChange={props.onRuntimeKindChange}
        grokRuntimeEnabled={props.grokRuntimeEnabled}
        provider={props.provider}
        onProviderChange={props.onProviderChange}
        providerOptions={props.providerOptions}
        model={props.model}
        onModelChange={props.onModelChange}
        advancedState={props.advancedState}
        onAdvancedChange={props.onAdvancedChange}
        advancedCount={props.advancedCount}
        toolMode={props.toolMode}
        onToolModeChange={props.onToolModeChange}
        workspaceRoot={props.workspaceRoot}
        onWorkspaceRootChange={props.onWorkspaceRootChange}
        defaultWorkspace={props.defaultWorkspace}
      />
      {props.runtimeKind === 'los' ? (
        <div className="skill-picker composer-power-fields" aria-label={t('chat.skills.pickerAria')}>
          <div className="skill-picker-head">
            <BookOpen size={13} aria-hidden="true" />
            <span>{t('chat.skills.label')}</span>
            <span className="skill-picker-hint">{t('chat.skills.autoOffHint')}</span>
            {skillsQuery.isLoading ? <span className="skill-picker-hint">{t('chat.skills.loading')}</span> : null}
            {!skillsQuery.isLoading && invocableSkills.length === 0 ? (
              <span className="skill-picker-hint">{t('chat.skills.empty')}</span>
            ) : null}
          </div>
          {invocableSkills.length > 0 ? (
            <div className="skill-chip-row">
              {invocableSkills.map(skill => {
                const active = props.selectedSkillIds.includes(skill.name);
                return (
                  <button
                    key={skill.id || skill.name}
                    type="button"
                    className={`skill-chip${active ? ' active' : ''}`}
                    title={skill.description || skill.name}
                    aria-pressed={active}
                    disabled={props.running}
                    onClick={() => toggleSkill(skill.name)}
                  >
                    {skill.name}
                    {skill.runMode === 'auto' ? <span className="skill-chip-badge">auto</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {props.selectedSkillIds.length > 0 ? (
            <p className="skill-picker-selected">
              {t('chat.skills.selected', { count: props.selectedSkillIds.length, names: props.selectedSkillIds.join(', ') })}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="composer-input-wrap">
        <textarea
          ref={textareaRef}
          value={props.prompt}
          onChange={event => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('chat.placeholder')}
          rows={3}
        />
        {visible && (
          <div className="slash-menu">
            {matches.map((c, i) => (
              <button
                key={c.cmd}
                className={`slash-item${i === slashIndex ? ' active' : ''}`}
                type="button"
                onMouseDown={e => { e.preventDefault(); applySlash(c.cmd); }}
                onMouseEnter={() => setSlashIndex(i)}
              >
                <strong>{c.cmd}</strong>
                <span>{t(c.descKey)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="composer-actions">
        <button className="primary-btn" type="submit" disabled={props.running || !props.prompt.trim()}>
          <Send size={15} /> {t('chat.send')}
        </button>
        <button className="ghost-btn" type="button" disabled={!props.running} onClick={props.onCancel}>
          <Square size={14} /> {t('chat.cancel')}
        </button>
      </div>
    </form>
  );
}
