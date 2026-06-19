import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'los.theme';

const ThemeContext = createContext<{
  mode: ThemeMode;
  resolved: 'dark' | 'light';
  setMode: (m: ThemeMode) => void;
}>({
  mode: 'dark',
  resolved: 'dark',
  setMode: () => {},
});

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'dark' || raw === 'light' || raw === 'system') return raw;
  } catch { /* ignore */ }
  return 'dark';
}

function resolveMode(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  // system — check media query
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeRaw] = useState<ThemeMode>(readStoredMode);
  const [resolved, setResolved] = useState<'dark' | 'light'>(() => resolveMode(mode));

  const setMode = useCallback((m: ThemeMode) => {
    setModeRaw(m);
    try { localStorage.setItem(STORAGE_KEY, m); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    setResolved(resolveMode(mode));
  }, [mode]);

  // Listen to system preference changes when in system mode
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setResolved(resolveMode('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  // Apply data-theme to documentElement
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
