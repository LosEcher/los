import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// ── Toast (Wave 2) ──────────────────────────────────────
// Global notification viewport. Wire <ToastProvider> once in main.tsx;
// consume via useToast(). Auto-dismisses after 4s; stacked at --z-toast.

type ToastKind = 'success' | 'error' | 'info' | 'warn';
type ToastItem = { id: number; kind: ToastKind; message: string };

const ToastContext = createContext<(kind: ToastKind, message: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setItems(prev => [...prev, { id, kind, message }]);
    window.setTimeout(() => {
      setItems(prev => prev.filter(item => item.id !== id));
    }, 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-viewport" role="region" aria-label="Notifications" aria-live="polite">
        {items.map(item => (
          <div key={item.id} className={`toast toast-${item.kind}`} role="status">
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  return {
    success: (message: string) => push('success', message),
    error: (message: string) => push('error', message),
    info: (message: string) => push('info', message),
    warn: (message: string) => push('warn', message),
  };
}
