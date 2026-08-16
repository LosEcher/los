import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, Search, type LucideIcon } from 'lucide-react';
import { Modal } from './modal';
import { NAV, type PageId } from '../nav-config';
import { useI18n } from '../i18n';

// ── Command palette (Wave 4, P2-3) ─────────────────────
// Cmd+K / Ctrl+K global navigation palette: page jumps from
// NAV + quick actions. Mounted once in App; keyboard handled
// here while open.

type PaletteItem = {
  id: string;
  title: string;
  hint: string;
  icon: LucideIcon;
  run: () => void;
};

export function CommandPalette({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (page: PageId) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const nav: PaletteItem[] = NAV.map(item => ({
      id: `nav:${item.id}`,
      title: t(item.labelKey),
      hint: item.audience,
      icon: item.icon,
      run: () => onNavigate(item.id),
    }));
    const actions: PaletteItem[] = [
      {
        id: 'action:new-chat',
        title: t('nav.chat'),
        hint: t('common.paletteNewChatHint'),
        icon: MessageSquare,
        run: () => onNavigate('chat'),
      },
    ];
    const all = [...actions, ...nav];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(item => item.title.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q));
  }, [query, t, onNavigate]);

  return (
    <Modal open={open} onClose={onClose} title={t('common.paletteTitle')} width={560}>
      <div className="palette">
        <div className="palette-search">
          <Search size={14} />
          <input
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('common.palettePlaceholder')}
            aria-label={t('common.palettePlaceholder')}
          />
        </div>
        <ul className="palette-list">
          {items.map(item => (
            <li key={item.id}>
              <button
                type="button"
                className="palette-item"
                onClick={() => {
                  item.run();
                  onClose();
                }}
              >
                <item.icon size={15} />
                <span>{item.title}</span>
                <code className="palette-hint">{item.hint}</code>
              </button>
            </li>
          ))}
          {items.length === 0 ? <li className="palette-empty">{t('common.paletteEmpty')}</li> : null}
        </ul>
      </div>
    </Modal>
  );
}
