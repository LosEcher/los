import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en } from './en/index';
import { zh } from './zh/index';

export type Lang = 'en' | 'zh';

export const LANGS: Lang[] = ['en', 'zh'];

const STORAGE_KEY = 'los.lang';

const DICTS: Record<Lang, Record<string, string>> = { en, zh };

// Module-level active language so non-hook helpers (formatDate, formatDuration)
// can localize without prop drilling. Kept in sync by I18nProvider.
let activeLang: Lang = 'en';

export function getActiveLang(): Lang {
  return activeLang;
}

/** Translate using the module-level active language (for non-hook helpers). */
export function tt(key: string, vars?: TParams): string {
  return translate(activeLang, key, vars);
}

export type TParams = Record<string, string | number>;

function translate(lang: Lang, key: string, vars?: TParams): string {
  const template = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export type I18nValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, vars?: TParams) => string;
};

const I18nContext = createContext<I18nValue>({
  lang: 'en',
  setLang: () => {},
  t: (key: string) => key,
});

function readStoredLang(): Lang {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'en' || raw === 'zh') return raw;
  } catch { /* ignore */ }
  // First visit: follow the browser language.
  try {
    return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangRaw] = useState<Lang>(() => {
    const initial = readStoredLang();
    // Keep the module-level active language in sync synchronously so tt()
    // and getActiveLang() see the new language in the same render pass.
    activeLang = initial;
    return initial;
  });

  const setLang = useCallback((next: Lang) => {
    activeLang = next;
    setLangRaw(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  const t = useCallback((key: string, vars?: TParams) => translate(lang, key, vars), [lang]);
  const value = useMemo<I18nValue>(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
