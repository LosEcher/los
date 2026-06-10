import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Archive,
  BarChart3,
  Boxes,
  Brain,
  ClipboardList,
  ListChecks,
  MemoryStick,
  MessageSquare,
  Network,
  Server,
  Settings,
  Shield,
  TerminalSquare,
  Zap,
} from 'lucide-react';
import { getJson, type Health, type SessionSummary, type TodoItem } from './api';
import {
  LogsPage,
  MemoryPage,
  ProvidersPage,
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
  | 'settings';

type NavItem = {
  id: PageId;
  label: string;
  icon: typeof MessageSquare;
  status: StatusState;
  badge?: number;
  section?: string;
};

const NAV: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare, status: 'live' },
  { id: 'sessions', label: 'Sessions', icon: ListChecks, status: 'live', section: 'Evidence' },
  { id: 'todos', label: 'Todos', icon: ClipboardList, status: 'live' },
  { id: 'tasks', label: 'Tasks', icon: Activity, status: 'live' },
  { id: 'memory', label: 'Memory', icon: MemoryStick, status: 'live' },
  { id: 'providers', label: 'Providers', icon: Brain, status: 'partial', section: 'Resources' },
  { id: 'skills', label: 'Skills', icon: Zap, status: 'live' },
  { id: 'mcp', label: 'MCP', icon: Server, status: 'live' },
  { id: 'services', label: 'Services', icon: Activity, status: 'live' },
  { id: 'artifacts', label: 'Artifacts', icon: Archive, status: 'live' },
  { id: 'rules', label: 'Rules', icon: Shield, status: 'live' },
  { id: 'evals', label: 'Evals', icon: BarChart3, status: 'partial', section: 'Quality' },
  { id: 'nodes', label: 'Nodes', icon: Network, status: 'partial', section: 'Infra' },
  { id: 'logs', label: 'Logs', icon: TerminalSquare, status: 'live' },
  { id: 'settings', label: 'Settings', icon: Settings, status: 'partial' },
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
            return (
              <div key={item.id}>
                {showSection ? <div className="nav-section">{item.section}</div> : null}
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
