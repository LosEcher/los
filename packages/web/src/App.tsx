import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Archive,
  BarChart3,
  Boxes,
  Brain,
  Bug,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  ListChecks,
  MemoryStick,
  MessageSquare,
  Network,
  ScrollText,
  Server,
  Settings,
  Shield,
  Skull,
  TerminalSquare,
  Zap,
} from 'lucide-react';
import { getJson, setAuthToken, getAuthToken, AuthError, type Health, type SessionSummary, type TodoItem } from './api';
import {
  DeadLetterPage,
  DiagnosticsPage,
  FileSyncPage,
  LogsPage,
  MemoryPage,
  ProvidersPage,
  RunSpecsPage,
  SessionsPage,
  SettingsPage,
  TasksPage,
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
import { formatDuration, StatusPill, type StatusState } from './ui';

type PageId =
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
  | 'nodes'
  | 'logs'
  | 'dead-letter'
  | 'diagnostics'
  | 'file-sync'
  | 'run-specs'
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
  { id: 'chat', label: 'Chat', icon: MessageSquare, status: 'live', audience: 'workspace' },
  { id: 'sessions', label: 'Sessions', icon: ListChecks, status: 'live', audience: 'workspace' },
  { id: 'todos', label: 'Todos', icon: ClipboardList, status: 'live', audience: 'workspace' },
  { id: 'memory', label: 'Memory', icon: MemoryStick, status: 'live', audience: 'workspace' },
  { id: 'artifacts', label: 'Artifacts', icon: Archive, status: 'partial', audience: 'workspace' },

  // ── Configure (setup, rarely changed) ────────────────────
  { id: 'providers', label: 'Providers', icon: Brain, status: 'live', audience: 'configure', section: 'Configure' },
  { id: 'skills', label: 'Skills', icon: Zap, status: 'partial', audience: 'configure' },
  { id: 'rules', label: 'Rules', icon: Shield, status: 'partial', audience: 'configure' },
  { id: 'mcp', label: 'MCP', icon: Server, status: 'partial', audience: 'configure' },
  { id: 'settings', label: 'Settings', icon: Settings, status: 'live', audience: 'configure' },

  // ── Operations (debug / incident investigation) ──────────
  { id: 'tasks', label: 'Tasks', icon: Activity, status: 'live', audience: 'operations', section: 'Operations' },
  { id: 'evals', label: 'Evals', icon: BarChart3, status: 'live', audience: 'operations' },
  { id: 'run-specs', label: 'Run Specs', icon: ScrollText, status: 'partial', audience: 'operations' },
  { id: 'nodes', label: 'Nodes', icon: Network, status: 'live', audience: 'operations' },
  { id: 'services', label: 'Services', icon: Activity, status: 'partial', audience: 'operations' },
  { id: 'logs', label: 'Logs', icon: TerminalSquare, status: 'partial', audience: 'operations' },
  { id: 'dead-letter', label: 'DLQ', icon: Skull, status: 'reserved', audience: 'operations' },
  { id: 'diagnostics', label: 'Diagnostics', icon: Bug, status: 'reserved', audience: 'operations' },
  { id: 'file-sync', label: 'File Sync', icon: Archive, status: 'partial', audience: 'operations' },
];

function pageFromHash(): PageId {
  const raw = window.location.hash.replace(/^#/, '');
  return NAV.find(n => n.id === raw)?.id ?? 'chat';
}

export function App() {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
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
    select: (data) => data.length,
  });

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
                    <StatusPill status={item.status} />
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
        {page === 'nodes' && <NodesPage />}
        {page === 'dead-letter' && <DeadLetterPage />}
        {page === 'diagnostics' && <DiagnosticsPage />}
        {page === 'file-sync' && <FileSyncPage />}
        {page === 'run-specs' && <RunSpecsPage />}
        {page === 'logs' && <LogsPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`metric ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

// ── Auth Banner ────────────────────────────────────────────

function AuthBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [saved, setSaved] = useState(false);

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => getJson<{ auth?: { enabled?: boolean } }>('/settings'),
    staleTime: 60_000,
  });

  const authEnabled = settings.data?.auth?.enabled === true;
  const hasToken = Boolean(getAuthToken());

  if (!authEnabled || hasToken || dismissed) return null;

  return (
    <div className="auth-banner">
      <span>🔐 Auth is enabled — set your token to access data.</span>
      <input
        type="password"
        value={tokenInput}
        onChange={e => setTokenInput(e.target.value)}
        placeholder="Paste auth token…"
        onKeyDown={e => {
          if (e.key === 'Enter') {
            setAuthToken(tokenInput.trim() || undefined);
            setSaved(true);
            setTimeout(() => setDismissed(true), 800);
          }
        }}
      />
      <button
        type="button"
        onClick={() => {
          setAuthToken(tokenInput.trim() || undefined);
          setSaved(true);
          setTimeout(() => setDismissed(true), 800);
        }}
      >
        {saved ? '✓ Saved' : 'Save'}
      </button>
      <button type="button" className="auth-dismiss" onClick={() => setDismissed(true)}>
        ×
      </button>
    </div>
  );
}
