import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Archive,
  BarChart3,
  Boxes,
  Brain,
  BriefcaseBusiness,
  Bug,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Inbox,
  ListChecks,
  MemoryStick,
  MessageSquare,
  Network,
  ScrollText,
  CalendarClock,
  Server,
  Scale,
  Settings,
  Shield,
  Skull,
  TerminalSquare,
  Zap,
  Wrench,
} from 'lucide-react';
import {
  getJson,
  type Health,
  type SessionSummary,
  type TodoItem,
  type MemoryStats,
  type WorkItemProjection,
} from './api';
import {
  CommunicationAccountsPage,
  DeadLetterPage,
  DiagnosticsPage,
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
import { AuthBanner } from './auth-banner';

type PageId =
  | 'inbox'
  | 'work'
  | 'schedules'
  | 'chat'
  | 'sessions'
  | 'todos'
  | 'tasks'
  | 'memory'
  | 'providers'
  | 'skills'
  | 'mcp'
  | 'services'
  | 'artifacts'
  | 'rules'
  | 'evals'
  | 'pairwise'
  | 'nodes'
  | 'logs'
  | 'dead-letter'
  | 'diagnostics'
  | 'file-sync'
  | 'run-specs'
  | 'communication-accounts'
  | 'setup'
  | 'settings';

type NavAudience = 'workspace' | 'configure' | 'operations';

type NavItem = {
  id: PageId;
  label: string;
  icon: typeof MessageSquare;
  status: StatusState;
  badge?: number;
  section?: string;
  audience: NavAudience;
};

const NAV: NavItem[] = [
  // ── Workspace (daily workflow) ──────────────────────────
  { id: 'inbox', label: 'Inbox', icon: Inbox, status: 'live', audience: 'workspace' },
  { id: 'work', label: 'Work', icon: BriefcaseBusiness, status: 'live', audience: 'workspace' },
  { id: 'schedules', label: 'Schedules', icon: CalendarClock, status: 'live', audience: 'workspace' },
  { id: 'chat', label: 'Chat', icon: MessageSquare, status: 'live', audience: 'workspace' },
  { id: 'sessions', label: 'Sessions', icon: ListChecks, status: 'live', audience: 'workspace' },
  { id: 'todos', label: 'Todos', icon: ClipboardList, status: 'live', audience: 'workspace' },
  { id: 'memory', label: 'Memory', icon: MemoryStick, status: 'live', audience: 'workspace' },
  { id: 'artifacts', label: 'Artifacts', icon: Archive, status: 'live', audience: 'workspace' },

  // ── Communication ─────────────────────────────────────
  { id: 'communication-accounts', label: 'Communications', icon: MessageSquare, status: 'live', audience: 'workspace', section: 'Communication' },

  // ── Configure (setup, rarely changed) ────────────────────
  { id: 'setup', label: 'Setup', icon: Wrench, status: 'live', audience: 'configure', section: 'Configure' },
  { id: 'providers', label: 'Providers', icon: Brain, status: 'live', audience: 'configure' },
  { id: 'skills', label: 'Skills', icon: Zap, status: 'live', audience: 'configure' },
  { id: 'rules', label: 'Rules', icon: Shield, status: 'live', audience: 'configure' },
  { id: 'mcp', label: 'MCP', icon: Server, status: 'live', audience: 'configure' },
  { id: 'settings', label: 'Settings', icon: Settings, status: 'live', audience: 'configure' },

  // ── Operations (debug / incident investigation) ──────────
  { id: 'tasks', label: 'Tasks', icon: Activity, status: 'live', audience: 'operations', section: 'Operations' },
  { id: 'evals', label: 'Evals', icon: BarChart3, status: 'live', audience: 'operations' },
  { id: 'pairwise', label: 'Pairwise', icon: Scale, status: 'live', audience: 'operations' },
  { id: 'run-specs', label: 'Run Specs', icon: ScrollText, status: 'live', audience: 'operations' },
  { id: 'nodes', label: 'Nodes', icon: Network, status: 'live', audience: 'operations' },
  { id: 'services', label: 'Services', icon: Activity, status: 'live', audience: 'operations' },
  { id: 'logs', label: 'Logs', icon: TerminalSquare, status: 'live', audience: 'operations' },
  { id: 'dead-letter', label: 'DLQ', icon: Skull, status: 'reserved', audience: 'operations' },
  { id: 'diagnostics', label: 'Diagnostics', icon: Bug, status: 'reserved', audience: 'operations' },
  { id: 'file-sync', label: 'File Sync', icon: Archive, status: 'live', audience: 'operations' },
];

function pageFromHash(): PageId {
  const raw = window.location.hash.replace(/^#/, '');
  return NAV.find(n => n.id === raw)?.id ?? 'inbox';
}

export function App() {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [selectedRunSpecId, setSelectedRunSpecId] = useState<string | null>(null);
  const [activeTodoContext, setActiveTodoContext] = useState<TodoItem | null>(null);
  const [branchFromSession, setBranchFromSession] = useState<string | null>(null);

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
    const onHashChange = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (id: PageId) => {
    setPage(id);
    window.location.hash = id;
  };
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => getJson<Health>('/health'),
    refetchInterval: 10_000,
  });
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
    setSelectedSessionId(id);
    setBranchFromSession(null);
    navigate('chat');
  };
  const branchSession = (id: string) => {
    setSelectedSessionId(null);
    setBranchFromSession(id);
    navigate('chat');
  };
  const openTodo = (id: string) => {
    setSelectedTodoId(id);
    navigate('todos');
  };
  const runTodo = (todo: TodoItem) => {
    setSelectedTodoId(todo.id);
    setActiveTodoContext(todo);
    setSelectedSessionId(todo.sessionId ?? null);
    navigate('chat');
  };
  const openWork = (id: string) => {
    setSelectedWorkItemId(id);
    navigate('work');
  };
  const openRun = (id: string) => {
    setSelectedRunSpecId(id);
    navigate('run-specs');
  };
  const startWork = (item: WorkItemProjection) => {
    setSelectedWorkItemId(item.id);
    setActiveTodoContext(workItemAsTodo(item));
    setSelectedSessionId(null);
    navigate('chat');
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark"><Boxes size={18} /></div>
          <div>
            <div className="brand-title">los console</div>
            <div className="brand-subtitle">agent runtime control</div>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          {NAV.map((item, idx) => {
            const Icon = item.icon;
            const prev = idx > 0 ? NAV[idx - 1] : null;
            const showSection = item.section && (!prev || prev.section !== item.section);
            const isOps = item.audience === 'operations';
            const isFirstOps = isOps && (!prev || prev.audience !== 'operations');

            return (
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
                    Operations
                    <span className="nav-section-count">{NAV.filter(n => n.audience === 'operations').length}</span>
                  </div>
                ) : showSection ? (
                  <div className="nav-section">{item.section}</div>
                ) : null}
                {isOps && !opsExpanded ? null : (
                  <button
                    type="button"
                    className="nav-item"
                    data-active={page === item.id}
                    onClick={() => navigate(item.id)}
                  >
                    <Icon size={16} />
                    <span>{item.label}</span>
                    {item.id === 'sessions' && sessionCount.data !== undefined ? (
                      <span className="nav-badge">{sessionCount.data}</span>
                    ) : null}
                    <StatusPill status={itemStatus(item.id, item.status)} />
                  </button>
                )}
              </div>
            );
          })}
        </nav>

        <div className="side-foot">
          <div className="mini-label">Gateway</div>
          <div className="health-row">
            <span className={`health-dot ${health.data?.status === 'ok' ? 'ok' : ''}`} />
            <span>{health.data?.status ?? 'checking'}</span>
          </div>
          <code>127.0.0.1:8080</code>
        </div>
      </aside>

      <main className="workspace">
        <AuthBanner />
        <header className="topbar">
          <div>
            <div className="eyebrow">Workspace</div>
            <h1>{active.label}</h1>
          </div>
          <div className="topbar-metrics">
            <Metric label="health" value={health.data?.status ?? 'unknown'} tone={health.data?.status === 'ok' ? 'ok' : 'warn'} />
            <Metric label="uptime" value={formatDuration(health.data?.uptime ?? 0)} />
            <Metric label="mode" value="local mesh" />
          </div>
        </header>

        {page === 'inbox' && <InboxPage onOpenWork={openWork} onOpenRun={openRun} onOpenSession={continueSession} />}
        {page === 'work' && <WorkPage selectedWorkItemId={selectedWorkItemId} onSelectedWorkItemChange={setSelectedWorkItemId} onStartWork={startWork} onOpenSession={continueSession} onOpenRun={openRun} />}
        {page === 'schedules' && <SchedulesPage />}
        {page === 'chat' && <ChatPage selectedSessionId={selectedSessionId} onSessionSelect={setSelectedSessionId} branchFromSession={branchFromSession} onBranchConsumed={() => setBranchFromSession(null)} activeTodoContext={activeTodoContext} onTodoContextClear={() => setActiveTodoContext(null)} />}
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
        {page === 'pairwise' && <PairwiseEvalsPage />}
        {page === 'nodes' && <NodesPage />}
        {page === 'dead-letter' && <DeadLetterPage />}
        {page === 'diagnostics' && <DiagnosticsPage />}
        {page === 'file-sync' && <FileSyncPage />}
        {page === 'run-specs' && <RunSpecsPage selectedRunSpecId={selectedRunSpecId} />}
        {page === 'communication-accounts' && <CommunicationAccountsPage />}
        {page === 'logs' && <LogsPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'setup' && <SetupPage />}
      </main>
    </div>
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

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`metric ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
