import { useEffect } from 'react';
import {
  BriefcaseBusiness,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Inbox,
  Menu,
  MessageSquare,
  Play,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  MOBILE_TAB_IDS,
  isMoreShellPage,
  moreNavGroups,
  type PageId,
} from './nav-config.js';
import { StatusPill, type StatusState } from './ui.js';
import { useI18n } from './i18n';

const TAB_META: Record<(typeof MOBILE_TAB_IDS)[number], { icon: LucideIcon; labelKey: string }> = {
  inbox: { icon: Inbox, labelKey: 'nav.inbox' },
  work: { icon: BriefcaseBusiness, labelKey: 'nav.work' },
  chat: { icon: MessageSquare, labelKey: 'nav.chat' },
};

type MobileTabBarProps = {
  page: PageId;
  onNavigate: (id: PageId) => void;
  moreOpen: boolean;
  onMoreClick: () => void;
  /** Attention count for Inbox tab badge (decisions waiting on operator). */
  inboxBadge?: number;
};

export function MobileTabBar({ page, onNavigate, moreOpen, onMoreClick, inboxBadge = 0 }: MobileTabBarProps) {
  const { t } = useI18n();
  const moreActive = moreOpen || isMoreShellPage(page);

  return (
    <nav className="mobile-tab-bar" aria-label={t('nav.mobileTabsAria')}>
      {MOBILE_TAB_IDS.map(id => {
        const item = TAB_META[id];
        const Icon = item.icon;
        const active = !moreOpen && page === id;
        const badge = id === 'inbox' && inboxBadge > 0 ? inboxBadge : 0;
        return (
          <button
            key={id}
            type="button"
            className="mobile-tab"
            data-active={active ? 'true' : 'false'}
            aria-current={active ? 'page' : undefined}
            aria-label={badge > 0 ? `${t(item.labelKey)} (${badge})` : undefined}
            onClick={() => onNavigate(id)}
          >
            <span className="mobile-tab-icon-wrap">
              <Icon size={20} aria-hidden />
              {badge > 0 ? <span className="mobile-tab-badge">{badge > 99 ? '99+' : badge}</span> : null}
            </span>
            <span>{t(item.labelKey)}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="mobile-tab"
        data-active={moreActive ? 'true' : 'false'}
        aria-expanded={moreOpen}
        aria-controls="los-more-sheet"
        onClick={onMoreClick}
      >
        <Menu size={20} aria-hidden />
        <span>{t('nav.more')}</span>
      </button>
    </nav>
  );
}

type MoreSheetProps = {
  open: boolean;
  page: PageId;
  onClose: () => void;
  onNavigate: (id: PageId) => void;
  needsOnboarding: boolean;
  sessionCount?: number;
  itemStatus: (itemId: string, hardStatus: StatusState) => StatusState;
  opsExpanded: boolean;
  onToggleOps: () => void;
};

export function MoreSheet({
  open,
  page,
  onClose,
  onNavigate,
  needsOnboarding,
  sessionCount,
  itemStatus,
  opsExpanded,
  onToggleOps,
}: MoreSheetProps) {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const groups = moreNavGroups();

  return (
    <div className="more-sheet-root" role="presentation">
      <button
        type="button"
        className="more-sheet-backdrop"
        aria-label={t('nav.closeMore')}
        onClick={onClose}
      />
      <div
        id="los-more-sheet"
        className="more-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.moreAria')}
      >
        <div className="more-sheet-head">
          <strong>{t('nav.more')}</strong>
          <button type="button" className="ghost-btn more-sheet-close" onClick={onClose}>
            <X size={16} aria-hidden />
            {t('common.close')}
          </button>
        </div>
        <div className="more-sheet-body">
          {groups.map(group => {
            const isOps = group.sectionKey === 'nav.section.operations';
            return (
              <section key={group.sectionKey} className="more-sheet-section">
                {isOps ? (
                  <button
                    type="button"
                    className={`more-sheet-section-label collapsible ${opsExpanded ? '' : 'collapsed'}`}
                    onClick={onToggleOps}
                  >
                    {opsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span>{t(group.sectionKey)}</span>
                    <span className="nav-section-count">{group.items.length}</span>
                  </button>
                ) : (
                  <div className="more-sheet-section-label">{t(group.sectionKey)}</div>
                )}
                {isOps && !opsExpanded ? null : (
                  <div className="more-sheet-items">
                    {group.sectionKey === 'nav.section.communication' ? (
                      <button
                        type="button"
                        className="more-sheet-item"
                        data-active={page === 'onboarding' ? 'true' : 'false'}
                        onClick={() => { onNavigate('onboarding'); onClose(); }}
                      >
                        <Play size={16} aria-hidden />
                        <span>{t('nav.onboarding')}</span>
                        <StatusPill status={needsOnboarding ? 'partial' : 'live'} />
                      </button>
                    ) : null}
                    {group.items.map(item => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className="more-sheet-item"
                          data-active={page === item.id ? 'true' : 'false'}
                          onClick={() => { onNavigate(item.id); onClose(); }}
                        >
                          <Icon size={16} aria-hidden />
                          <span>{t(item.labelKey)}</span>
                          {item.id === 'sessions' && sessionCount !== undefined ? (
                            <span className="nav-badge">{sessionCount}</span>
                          ) : null}
                          {item.id === 'schedules' ? (
                            <CalendarClock size={14} className="more-sheet-hint-icon" aria-hidden />
                          ) : null}
                          {item.showStatus === false ? null : (
                            <StatusPill status={itemStatus(item.id, item.status)} />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
