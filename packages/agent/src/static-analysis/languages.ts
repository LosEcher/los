import { js, jsx, ts, tsx, parse, type SgNode, type SgRoot } from '@ast-grep/napi';

type LangKey = 'ts' | 'tsx' | 'js' | 'jsx';

const PARSERS: Record<LangKey, (src: string) => SgRoot> = {
  ts: (src: string) => parse('TypeScript', src),
  tsx: (src: string) => parse('Tsx', src),
  js: (src: string) => parse('JavaScript', src),
  jsx: (src: string) => parse('JavaScript', src),
};

const LANG_BY_EXT: Record<string, LangKey> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mts': 'ts',
  '.mjs': 'js',
  '.cjs': 'js',
  '.cts': 'ts',
};

const LANG_NAME: Record<LangKey, string> = {
  ts: 'TypeScript',
  tsx: 'Tsx',
  js: 'JavaScript',
  jsx: 'JavaScript',
};

export function languageFromFilePath(filePath: string): LangKey | null {
  for (const [ext, lang] of Object.entries(LANG_BY_EXT)) {
    if (filePath.endsWith(ext)) return lang as LangKey;
  }
  return null;
}

export function parseSource(lang: LangKey, src: string): SgRoot {
  return PARSERS[lang](src);
}

export function languageName(lang: LangKey): string {
  return LANG_NAME[lang];
}

export type { LangKey, SgNode, SgRoot };
