import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';

// ── Modal (Wave 2) ──────────────────────────────────────
// Accessible dialog: Esc to close, focus trap inside the
// dialog, body scroll lock while open, backdrop click to
// close. Uses --z-modal / --overlay tokens. Abstracted from
// the MoreSheet / Abort-dialog patterns so callers stop
// hand-rolling dialogs per page.

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const focusables = dialog?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables?.[0] ?? dialog;
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (dialog && !dialog.contains(event.target as Node)) {
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-root" role="presentation">
      <button
        type="button"
        className="modal-backdrop"
        aria-label={t('common.close')}
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={width ? { width } : undefined}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
