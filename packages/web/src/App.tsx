import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Moon,
  Sun,
  Monitor,
  Play,
} from 'lucide-react';
import {
  getJson,
  postJson,
  type Health,
  type InboxResponse,
  type SessionSummary,
  type TodoItem,
  type MemoryStats,
  type WorkItemProjection,
} from './api';
import {
  CommunicationAccountsPage,
  DeadLetterPage,
  GovernancePage,
  DiagnosticsPage,
  UsagePage,
  FileSyncPage,
  LogsPage,
  MemoryPage,
  ProvidersPage,
  RunSpecsPage,
  SessionsPage,
  SettingsPage,
  SetupPage,
  TasksPage,
  InboxPage,
  WorkPage,
  SchedulesPage,
} from './pages';
import { ChatPage } from './chat-page';
import { NodesPage } from './nodes-page';
import { TodosPage } from './todo-page';
import { MCPServersPage } from './mcp-page';
import { ServicesPage } from './service-page';
import { ArtifactsPage } from './artifact-page';
import { SkillsPage } from './skills-page';
import { RulesPage } from './rules-page';
import { EvalsPage } from './evals-page';
import { PairwiseEvalsPage } from './pairwise-evals-page';
import { formatDuration, StatusPill, type StatusState } from './ui';
import { LANGS, useI18n } from './i18n';
import { useTheme, type ThemeMode } from './hooks/useTheme';
import { AuthBanner } from './auth-banner';
import { LoginPage, isAuthenticated, logout } from './pages/login-page';
import { OnboardingPage } from './pages/onboarding-page';
import { getAuthToken } from './api';
import { NAV, buildHash, parseHash, type NavItem, type PageId } from './nav-config';
import { MobileTabBar, MoreSheet } from './mobile-nav';

function initialRoute() {
  const route = parseHash();
  // `#inbox?id=` is a deep-link alias for opening Work detail.
  if (route.page === 'inbox' && route.workItemId) {
    return { page: 'work' as const, workItemId: route.workItemId };
  }
  return route;
}

export function App() {
  const { t, lang, setLang } = useI18n();
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const boot = initialRoute();
  const [page, setPage] = useState<PageId>(boot.page);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(boot.sessionId ?? null);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(boot.workItemId ?? null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(boot.scheduleId ?? null);
  const [usageDay, setUsageDay] = useState<string | null>(boot.day ?? null);
  const [selectedRunSpecId, setSelectedRunSpecId] = useState<string | null>(null);
  const [activeTodoContext, setActiveTodoContext] = useState<TodoItem | null>(null);
  const [branchFromSession, setBranchFromSession] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(() => isAuthenticated());
  const [moreOpen, setMoreOpen] = useState(false);

  // Operations section collapsible — default collapsed, persisted in localStorage
  const [opsExpanded, setOpsExpanded] = useState(() => {
    try { return localStorage.getItem('los.nav.opsExpanded') === 'true'; } catch { return false; }
  });
  const toggleOps = () => {
    const next = !opsExpanded;
    setOpsExpanded(next);
    try { localStorage.setItem('los.nav.opsExpanded', String(next)); } catch { /* ignore */ }
  };

  useEffect(() => {
    const applyRoute = () => {
      const route = parseHash();
      if (route.page === 'inbox' && route.workItemId) {
        setPage('work');
        setSelectedWorkItemId(route.workItemId);
        const next = buildHash({ page: 'work', workItemId: route.workItemId });
        if (window.location.hash.replace(/^#/, '') !== next) {
          window.location.hash = next;
        }
        return;
      }
      setPage(route.page);
      if (route.workItemId) setSelectedWorkItemId(route.workItemId);
      if (route.sessionId) setSelectedSessionId(route.sessionId);
      if (route.scheduleId) setSelectedScheduleId(route.scheduleId);
      else if (route.page === 'schedules' && !route.scheduleId) setSelectedScheduleId(null);
      if (route.day) setUsageDay(route.day);
      else if (route.page === 'usage' && !route.day) setUsageDay(null);
    };
    // Normalize boot deep-links once (e.g. #inbox?id= → #work/<id>).
    applyRoute();
    const onHashChange = () => applyRoute();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Deep-link into Ops should expand the collapsible section so the active item is visible.
  useEffect(() => {
    const item = NAV.find(n => n.id === page);
    if (item?.audience === 'operations') {
      setOpsExpanded(true);
      try { localStorage.setItem('los.nav.opsExpanded', 'true'); } catch { /* ignore */ }
    }
  }, [page]);

  const navigate = (id: PageId, opts?: {
    workItemId?: string | null;
    sessionId?: string | null;
    scheduleId?: string | null;
    day?: string | null;
  }) => {
    setPage(id);
    // Bare Work/Chat tab clears deep-link selection so phone returns to list/empty chat.
    if (opts && 'workItemId' in opts) setSelectedWorkItemId(opts.workItemId ?? null);
    else if (id === 'work' && !opts) setSelectedWorkItemId(null);
    if (opts && 'sessionId' in opts) setSelectedSessionId(opts.sessionId ?? null);
    else if (id === 'chat' && !opts) setSelectedSessionId(null);
    if (opts && 'scheduleId' in opts) setSelectedScheduleId(opts.scheduleId ?? null);
    else if (id === 'schedules' && !opts) setSelectedScheduleId(null);
    if (opts && 'day' in opts) setUsageDay(opts.day ?? null);
    else if (id === 'usage' && !opts) setUsageDay(null);
    window.location.hash = buildHash({
      page: id,
      workItemId: id === 'work' ? (opts?.workItemId ?? undefined) : undefined,
      sessionId: id === 'chat' ? (opts?.sessionId ?? undefined) : undefined,
      scheduleId: id === 'schedules' ? (opts?.scheduleId ?? undefined) : undefined,
      day: id === 'usage' ? (opts?.day ?? undefined) : undefined,
    });
    setMoreOpen(false);
  };
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => getJson<Health>('/health'),
    refetchInterval: 10_000,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => getJson<{ auth?: { enabled?: boolean } }>('/settings'),
    staleTime: 60_000,
  });
  const authEnabled = settings.data?.auth?.enabled === true;

  // Onboarding auto-detect: redirect to onboarding when no providers are configured
  const onboarding = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => getJson<{ summary?: { readyProviders?: number; totalProviders?: number } }>('/onboarding'),
    staleTime: 30_000,
    enabled: !authEnabled || authenticated,
  });
  const needsOnboarding = onboarding.data?.summary?.totalProviders === 0;

  // Auto-redirect to onboarding when no providers (once on load)
  useEffect(() => {
    if (needsOnboarding && page !== 'onboarding' && page !== 'setup' && page !== 'providers' && page !== 'settings') {
      navigate('onboarding');
    }
  }, [needsOnboarding]);

  const sessionCount = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getJson<SessionSummary[]>('/sessions'),
    refetchInterval: 30_000,
    select: (data) => data.filter(s => !s.id.startsWith('session-trace-')).length,
  });
  const dataStats = useQuery({
    queryKey: ['data-stats'],
    queryFn: async () => {
      const [skills, rules, memStats] = await Promise.all([
        getJson<{ id: string }[]>('/skills?limit=1'),
        getJson<{ id: string }[]>('/rules?limit=1'),
        getJson<MemoryStats>('/memory/stats'),
      ]);
      return {
        skillsCount: Array.isArray(skills) ? skills.length : 0,
        rulesCount: Array.isArray(rules) ? rules.length : 0,
        memoryCount: memStats?.totalObservations ?? 0,
      };
    },
    refetchInterval: 30_000,
  });

  function itemStatus(itemId: string, hardStatus: StatusState): StatusState {
    const s = dataStats.data;
    switch (itemId) {
      case 'skills': return (s?.skillsCount ?? 0) > 0 ? 'live' : 'partial';
      case 'rules': return (s?.rulesCount ?? 0) > 0 ? 'live' : 'partial';
      case 'memory': return (s?.memoryCount ?? 0) > 0 ? 'live' : 'partial';
      case 'sessions': return (sessionCount.data ?? 0) > 0 ? 'live' : 'partial';
      default: return hardStatus;
    }
  }

  const active = NAV.find(item => item.id === page) ?? NAV[0]!;
  const continueSession = (id: string) => {
    setBranchFromSession(null);
    navigate('chat', { sessionId: id });
  };
  const branchSession = (id: string) => {
    setBranchFromSession(id);
    navigate('chat', { sessionId: null });
  };
  const openTodo = (id: string) => {
    setSelectedTodoId(id);
    navigate('todos');
  };
  const runTodo = (todo: TodoItem) => {
    setSelectedTodoId(todo.id);
    setActiveTodoContext(todo);
    navigate('chat', { sessionId: todo.sessionId ?? null });
  };
  const openWork = (id: string) => {
    navigate('work', { workItemId: id });
  };
  const openRun = (id: string) => {
    setSelectedRunSpecId(id);
    navigate('run-specs');
  };
  const startWork = (item: WorkItemProjection) => {
    setActiveTodoContext(workItemAsTodo(item));
    navigate('chat', { workItemId: item.id, sessionId: null });
  };
  const selectWorkItem = (id: string | null) => {
    setSelectedWorkItemId(id);
    window.location.hash = buildHash({ page: 'work', workItemId: id ?? undefined });
  };

  const selectSchedule = (id: string | null) => {
    setSelectedScheduleId(id);
    window.location.hash = buildHash({ page: 'schedules', scheduleId: id ?? undefined });
  };

  const inboxBadge = useQuery({
    queryKey: ['inbox', 'badge'],
    queryFn: () => getJson<InboxResponse>('/inbox?limit=100'),
    refetchInterval: 15_000,
    select: data => (data.results ?? []).filter(entry => entry.attentionState !== 'none' && entry.attentionState !== 'running').length,
  });
  const queryClient = useQueryClient();
  const approvePlan = useMutation({
    mutationFn: (runSpecId: string) => postJson(`/runs/${runSpecId}/approve`, { reason: 'plan reviewed from inbox' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
      queryClient.invalidateQueries({ queryKey: ['work-items'] });
    },
  });
  const handleApprovePlan = (runSpecId: string) => {
    if (!approvePlan.isPending) approvePlan.mutate(runSpecId);
  };

  const activeLabelKey = page === 'onboarding' ? 'nav.onboarding' : active.labelKey;

  return (
    <>
      {authEnabled && !authenticated ? (
        <LoginPage onLogin={() => setAuthenticated(true)} />
      ) : (
    <div className="app-shell" data-page={page}>
      <aside className="sidebar desktop-sidebar">
        <div className="brand-block">
          <div className="brand-mark"><Boxes size={18} /></div>
          <div>
            <div className="brand-title">los console</div>
            <div className="brand-subtitle">{t('nav.brandSubtitle')}</div>
          </div>
        </div>

        <nav className="nav-list" aria-label={t('nav.primaryAria')}>
          {NAV.map((item, idx) => {
            const Icon = item.icon;
            const prev = idx > 0 ? NAV[idx - 1] : null;
            const showSection = item.sectionKey && (!prev || prev.sectionKey !== item.sectionKey);
            const isOps = item.audience === 'operations';
            const isFirstOps = isOps && (!prev || prev.audience !== 'operations');

            // Inject onboarding after Communication section heading
            const content = [];

            if (showSection && item.sectionKey === 'nav.section.communication') {
              content.push(
                <div key="onboarding-nav-item">
                  <button
                    type="button"
                    className="nav-item"
                    data-active={page === 'onboarding'}
                    onClick={() => navigate('onboarding')}
                  >
                    <Play size={16} />
                    <span>{t('nav.onboarding')}</span>
                    <StatusPill status={needsOnboarding ? 'partial' : 'live'} />
                  </button>
                </div>
              );
            }

            content.push(
              <div key={item.id}>
                {isFirstOps ? (
                  <div
                    className={`nav-section nav-section-collapsible ${opsExpanded ? '' : 'collapsed'}`}
                    onClick={toggleOps}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') toggleOps(); }}
                  >
                    {opsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {t('nav.section.operations')}
                    <span className="nav-section-count">{NAV.filter(n => n.audience === 'operations').length}</span>
                  </div>
                ) : showSection ? (
                  <div className="nav-section">{item.sectionKey ? t(item.sectionKey) : null}</div>
                ) : null}
                {isOps && !opsExpanded ? null : (
                  <button
                    type="button"
                    className="nav-item"
                    data-active={page === item.id}
                    onClick={() => navigate(item.id)}
                  >
                    <Icon size={16} />
                    <span>{t(item.labelKey)}</span>
                    {item.id === 'sessions' && sessionCount.data !== undefined ? (
                      <span className="nav-badge">{sessionCount.data}</span>
                    ) : null}
                    {item.showStatus === false ? null : (
                      <StatusPill status={itemStatus(item.id, item.status)} />
                    )}
                  </button>
                )}
              </div>
            );
            return content;
          })}
        </nav>

        <div className="side-foot">
          <div className="mini-label">{t('nav.gateway')}</div>
          <div className="health-row">
            <span className={`health-dot ${health.data?.status === 'ok' ? 'ok' : ''}`} />
            <span>{healthText(health.data?.status, t)}</span>
          </div>
          <code>127.0.0.1:8080</code>
          {authEnabled && authenticated ? (
            <button type="button" className="logout-btn" onClick={() => { logout(); setAuthenticated(false); }}>
              {t('nav.signOut')}
            </button>
          ) : null}
        </div>
      </aside>

      <main className="workspace">
        <AuthBanner />
        <header className="topbar">
          <div>
            <div className="eyebrow">{page === 'onboarding' ? t('nav.section.configure') : navEyebrow(active, t)}</div>
            <h1>{t(activeLabelKey)}</h1>
          </div>
          <div className="topbar-metrics">
            <Metric label={t('nav.metric.health')} value={healthText(health.data?.status, t)} tone={health.data?.status === 'ok' ? 'ok' : 'warn'} />
            <Metric label={t('nav.metric.uptime')} value={formatDuration(health.data?.uptime ?? 0)} />
            <Metric label={t('nav.metric.mode')} value={t('common.localMesh')} />
            <div className="theme-switch theme-switch-compact" role="radiogroup" aria-label={t('pages.settings.field.theme')}>
              {([
                { id: 'dark' as ThemeMode, icon: Moon, titleKey: 'pages.settings.theme.dark' },
                { id: 'light' as ThemeMode, icon: Sun, titleKey: 'pages.settings.theme.light' },
                { id: 'system' as ThemeMode, icon: Monitor, titleKey: 'pages.settings.theme.system' },
              ]).map(option => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={themeMode === option.id}
                    title={t(option.titleKey)}
                    className={themeMode === option.id ? 'active' : ''}
                    onClick={() => setThemeMode(option.id)}
                  >
                    <Icon size={14} />
                  </button>
                );
              })}
            </div>
            <div className="lang-switch" role="group" aria-label={t('nav.languageAria')}>
              {LANGS.map(l => (
                <button
                  key={l}
                  type="button"
                  className={lang === l ? 'active' : ''}
                  onClick={() => setLang(l)}
                >
                  {l === 'zh' ? '中文' : 'EN'}
                </button>
              ))}
            </div>
          </div>
        </header>

        {page === 'inbox' && <InboxPage onOpenWork={openWork} onOpenRun={openRun} onOpenSession={continueSession} onApprovePlan={handleApprovePlan} onStartWork={startWork} />}
        {page === 'work' && <WorkPage selectedWorkItemId={selectedWorkItemId} onSelectedWorkItemChange={selectWorkItem} onStartWork={startWork} onOpenSession={continueSession} onOpenRun={openRun} />}
        {page === 'schedules' && (
          <SchedulesPage
            selectedScheduleId={selectedScheduleId}
            onSelectedScheduleChange={selectSchedule}
            onOpenSession={continueSession}
          />
        )}
        {page === 'chat' && <ChatPage selectedSessionId={selectedSessionId} onSessionSelect={setSelectedSessionId} branchFromSession={branchFromSession} onBranchConsumed={() => setBranchFromSession(null)} activeTodoContext={activeTodoContext} onTodoContextSet={setActiveTodoContext} onTodoContextClear={() => setActiveTodoContext(null)} />}
        {page === 'sessions' && <SessionsPage selectedSessionId={selectedSessionId} onSelectSession={setSelectedSessionId} onContinueSession={continueSession} onBranchSession={branchSession} onSelectTodo={openTodo} />}
        {page === 'todos' && <TodosPage selectedTodoId={selectedTodoId} onTodoSelect={setSelectedTodoId} onRunTodo={runTodo} onSelectSession={continueSession} />}
        {page === 'tasks' && <TasksPage onSelectSession={continueSession} />}
        {page === 'memory' && <MemoryPage />}
        {page === 'providers' && <ProvidersPage />}
        {page === 'skills' && <SkillsPage />}
        {page === 'mcp' && <MCPServersPage />}
        {page === 'services' && <ServicesPage />}
        {page === 'artifacts' && <ArtifactsPage />}
        {page === 'rules' && <RulesPage />}
        {page === 'evals' && <EvalsPage />}
        {page === 'usage' && <UsagePage day={usageDay} />}
        {page === 'pairwise' && <PairwiseEvalsPage onOpenRun={openRun} onOpenSession={continueSession} />}
        {page === 'nodes' && <NodesPage />}
        {page === 'dead-letter' && <DeadLetterPage />}
        {page === 'governance' && <GovernancePage />}
        {page === 'diagnostics' && <DiagnosticsPage />}
        {page === 'file-sync' && <FileSyncPage />}
        {page === 'run-specs' && <RunSpecsPage selectedRunSpecId={selectedRunSpecId} />}
        {page === 'communication-accounts' && <CommunicationAccountsPage />}
        {page === 'logs' && <LogsPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'setup' && <SetupPage />}
        {page === 'onboarding' && <OnboardingPage onReady={() => navigate('chat')} />}
      </main>

      <MobileTabBar
        page={page}
        onNavigate={navigate}
        moreOpen={moreOpen}
        onMoreClick={() => setMoreOpen(open => !open)}
        inboxBadge={inboxBadge.data ?? 0}
      />
      <MoreSheet
        open={moreOpen}
        page={page}
        onClose={() => setMoreOpen(false)}
        onNavigate={navigate}
        needsOnboarding={Boolean(needsOnboarding)}
        sessionCount={sessionCount.data}
        itemStatus={itemStatus}
        opsExpanded={opsExpanded}
        onToggleOps={toggleOps}
      />
    </div>
      )}
    </>
  );
}

function workItemAsTodo(item: WorkItemProjection): TodoItem {
  return {
    id: item.id,
    tenantId: item.tenantId,
    projectId: item.projectId,
    userId: item.userId,
    title: item.title,
    description: item.description,
    kind: 'task',
    status: item.status,
    priority: item.priority,
    source: item.source,
    dependsOnIds: [],
    blockedByIds: [],
    metadata: { runContract: item.runContractDraft },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function navEyebrow(item: NavItem, t: (key: string) => string): string {
  if (item.audience === 'operations') return t('nav.section.operations');
  if (item.audience === 'configure') return t('nav.section.configure');
  if (item.sectionKey) return t(item.sectionKey);
  return t('nav.section.daily');
}

function healthText(status: string | undefined, t: (key: string) => string): string {
  if (!status) return t('common.checking');
  const known: Record<string, string> = {
    ok: 'common.ok',
    degraded: 'common.degraded',
    down: 'common.down',
  };
  return known[status] ? t(known[status]) : status;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`metric ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
