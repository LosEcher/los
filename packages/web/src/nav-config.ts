/**
 * W4 navigation contract + mobile daily shell.
 * Daily (default): Inbox → Work → Schedules → Chat
 * Library / Advanced / Communication / Configure / Ops behind More on phone.
 */
import {
  Activity,
  Archive,
  BarChart3,
  Brain,
  BriefcaseBusiness,
  Bug,
  CalendarClock,
  CircleDollarSign,
  ClipboardList,
  Inbox,
  ListChecks,
  MemoryStick,
  MessageSquare,
  Network,
  Scale,
  ScrollText,
  Server,
  Settings,
  Shield,
  Skull,
  TerminalSquare,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { StatusState } from './ui';

export type PageId =
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
  | 'usage'
  | 'pairwise'
  | 'nodes'
  | 'logs'
  | 'dead-letter'
  | 'governance'
  | 'diagnostics'
  | 'file-sync'
  | 'run-specs'
  | 'communication-accounts'
  | 'setup'
  | 'settings'
  | 'onboarding';

export type NavAudience = 'workspace' | 'configure' | 'operations';

export type NavItem = {
  id: PageId;
  labelKey: string;
  icon: LucideIcon;
  status: StatusState;
  badge?: number;
  sectionKey?: string;
  audience: NavAudience;
  /** When false, hide StatusPill — daily decision pages stay quiet. Default true. */
  showStatus?: boolean;
};

/** Phone bottom tabs (Schedules lives in More under Daily). */
export const MOBILE_TAB_IDS = ['inbox', 'work', 'chat'] as const satisfies readonly PageId[];

export type MobileTabId = (typeof MOBILE_TAB_IDS)[number];

export function isMobileTabPage(id: PageId): id is MobileTabId {
  return (MOBILE_TAB_IDS as readonly string[]).includes(id);
}

/** Pages that light up the More tab on the mobile shell. */
export function isMoreShellPage(id: PageId): boolean {
  return !isMobileTabPage(id);
}

export const NAV: NavItem[] = [
  // ── Daily workflow (decision path) ──────────────────────
  { id: 'inbox', labelKey: 'nav.inbox', icon: Inbox, status: 'live', audience: 'workspace', showStatus: false },
  { id: 'work', labelKey: 'nav.work', icon: BriefcaseBusiness, status: 'live', audience: 'workspace', showStatus: false },
  { id: 'schedules', labelKey: 'nav.schedules', icon: CalendarClock, status: 'live', audience: 'workspace', showStatus: false },
  { id: 'chat', labelKey: 'nav.chat', icon: MessageSquare, status: 'live', audience: 'workspace', showStatus: false },

  // ── Library (history / knowledge) ───────────────────────
  { id: 'sessions', labelKey: 'nav.sessions', icon: ListChecks, status: 'partial', audience: 'workspace', sectionKey: 'nav.section.library' },
  { id: 'memory', labelKey: 'nav.memory', icon: MemoryStick, status: 'partial', audience: 'workspace' },
  { id: 'artifacts', labelKey: 'nav.artifacts', icon: Archive, status: 'partial', audience: 'workspace' },

  // ── Advanced (compat / non-default) ─────────────────────
  { id: 'todos', labelKey: 'nav.todos', icon: ClipboardList, status: 'partial', audience: 'workspace', sectionKey: 'nav.section.advanced' },

  // ── Communication ─────────────────────────────────────
  { id: 'communication-accounts', labelKey: 'nav.communicationAccounts', icon: MessageSquare, status: 'partial', audience: 'workspace', sectionKey: 'nav.section.communication' },

  // ── Configure (setup, rarely changed) ────────────────────
  { id: 'setup', labelKey: 'nav.setup', icon: Wrench, status: 'live', audience: 'configure', sectionKey: 'nav.section.configure' },
  { id: 'providers', labelKey: 'nav.providers', icon: Brain, status: 'partial', audience: 'configure' },
  { id: 'skills', labelKey: 'nav.skills', icon: Zap, status: 'partial', audience: 'configure' },
  { id: 'rules', labelKey: 'nav.rules', icon: Shield, status: 'partial', audience: 'configure' },
  { id: 'mcp', labelKey: 'nav.mcp', icon: Server, status: 'partial', audience: 'configure' },
  { id: 'settings', labelKey: 'nav.settings', icon: Settings, status: 'partial', audience: 'configure' },

  // ── Operations (troubleshoot / evidence dump) ───────────
  { id: 'tasks', labelKey: 'nav.tasks', icon: Activity, status: 'partial', audience: 'operations', sectionKey: 'nav.section.operations' },
  { id: 'run-specs', labelKey: 'nav.runSpecs', icon: ScrollText, status: 'partial', audience: 'operations' },
  { id: 'evals', labelKey: 'nav.evals', icon: BarChart3, status: 'partial', audience: 'operations' },
  { id: 'usage', labelKey: 'nav.usage', icon: CircleDollarSign, status: 'live', audience: 'operations' },
  { id: 'pairwise', labelKey: 'nav.pairwise', icon: Scale, status: 'partial', audience: 'operations' },
  { id: 'nodes', labelKey: 'nav.nodes', icon: Network, status: 'partial', audience: 'operations' },
  { id: 'services', labelKey: 'nav.services', icon: Activity, status: 'partial', audience: 'operations' },
  { id: 'logs', labelKey: 'nav.logs', icon: TerminalSquare, status: 'partial', audience: 'operations' },
  { id: 'file-sync', labelKey: 'nav.fileSync', icon: Archive, status: 'partial', audience: 'operations' },
  { id: 'dead-letter', labelKey: 'nav.dlq', icon: Skull, status: 'reserved', audience: 'operations' },
  { id: 'governance', labelKey: 'nav.governance', icon: Shield, status: 'live', audience: 'operations' },
  { id: 'diagnostics', labelKey: 'nav.diagnostics', icon: Bug, status: 'reserved', audience: 'operations' },
];

export type HashRoute = {
  page: PageId;
  /** Selected work item for `#work/<id>` or `#work?id=` / `#inbox?id=` open-work. */
  workItemId?: string;
  /** Chat session deep link `#chat?session=`. */
  sessionId?: string;
};

/** Parse location.hash into page + optional deep-link ids. */
export function parseHash(rawHash = typeof window !== 'undefined' ? window.location.hash : ''): HashRoute {
  const raw = rawHash.replace(/^#/, '').trim();
  if (!raw) return { page: 'inbox' };

  const workPath = raw.match(/^work\/([^/?#]+)\/?$/);
  if (workPath?.[1]) {
    return { page: 'work', workItemId: safeDecode(workPath[1]) };
  }

  const [pathPart, query = ''] = raw.split('?');
  const path = pathPart || 'inbox';
  const params = new URLSearchParams(query);
  const page: PageId = NAV.find(n => n.id === path)?.id
    ?? (path === 'onboarding' ? 'onboarding' : 'inbox');

  const workItemId = params.get('id')?.trim() || undefined;
  const sessionId = params.get('session')?.trim() || undefined;

  if (page === 'work' && workItemId) return { page, workItemId };
  if (page === 'inbox' && workItemId) return { page, workItemId };
  if (page === 'chat' && sessionId) return { page, sessionId: safeDecode(sessionId) };
  return { page };
}

export function pageFromHash(): PageId {
  return parseHash().page;
}

/** Build a hash fragment (without leading `#`) for navigation. */
export function buildHash(route: { page: PageId; workItemId?: string; sessionId?: string }): string {
  if (route.page === 'work' && route.workItemId) {
    return `work/${encodeURIComponent(route.workItemId)}`;
  }
  if (route.page === 'chat' && route.sessionId) {
    return `chat?session=${encodeURIComponent(route.sessionId)}`;
  }
  if (route.page === 'inbox' && route.workItemId) {
    return `inbox?id=${encodeURIComponent(route.workItemId)}`;
  }
  return route.page;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Group More-sheet entries for phone secondary nav. */
export function moreNavGroups(): Array<{ sectionKey: string; items: NavItem[] }> {
  const groups: Array<{ sectionKey: string; items: NavItem[] }> = [];
  // Schedules is daily but not a bottom tab — surface first in More.
  groups.push({
    sectionKey: 'nav.section.daily',
    items: NAV.filter(item => item.id === 'schedules'),
  });

  let current: { sectionKey: string; items: NavItem[] } | null = null;
  for (const item of NAV) {
    if (isMobileTabPage(item.id) || item.id === 'schedules') continue;
    const sectionKey = item.sectionKey
      ?? (item.audience === 'configure'
        ? 'nav.section.configure'
        : item.audience === 'operations'
          ? 'nav.section.operations'
          : 'nav.section.library');
    if (!current || current.sectionKey !== sectionKey) {
      current = { sectionKey, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups.filter(group => group.items.length > 0);
}
