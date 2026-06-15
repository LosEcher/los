export interface StaticAnalysisRule {
  id: string;
  language: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  rule: Record<string, unknown>;
  constraints?: StaticAnalysisConstraint[] | null;
  fix?: { replace: string; joinBy?: string } | null;
  governance?: {
    domain?: string[] | null;
    owner?: string;
    impact?: 'low' | 'medium' | 'high';
    rationale?: string;
  } | null;
  ruleFile?: string;
}

export interface StaticAnalysisConstraint {
  name: string;
  regex: string;
  flags?: string;
  mode?: 'any' | 'all';
}

export interface StaticAnalysisPosition {
  line: number;
  column: number;
  index: number;
}

export interface StaticAnalysisRange {
  start: StaticAnalysisPosition;
  end: StaticAnalysisPosition;
}

export interface StaticAnalysisFinding {
  tool: string;
  version: number;
  timestamp: string;
  project: string;
  ruleFile: string | null;
  ruleId: string;
  findingSource: string;
  governanceDomain: string[] | null;
  impactHint: string | null;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file: string;
  language: string;
  range: StaticAnalysisRange;
  excerpt: string;
  hasFix: boolean;
  proposedReplacement: string | null;
  fingerprint: string;
}

export interface StaticAnalysisScanOptions {
  project?: string;
  rootDir: string;
  include?: string[];
  ignore?: string[];
  rules?: StaticAnalysisRule[];
  deterministic?: boolean;
  signal?: AbortSignal;
}

export interface StaticAnalysisScanResult {
  filesScanned: number;
  findings: StaticAnalysisFinding[];
  parseFailures?: {
    count: number;
    byLanguage: Record<string, number>;
    samples: Array<{ file: string; language: string; error: string }>;
  };
}

export interface StaticAnalysisParseCache {
  parseFile(
    filePath: string,
    language: string,
    opts?: { cacheAst?: boolean },
  ): Promise<{ root: unknown; source: string; hit: boolean }>;
  invalidateFile(filePath: string): void;
  snapshotStats(): { hits: number; misses: number; evictions: number; entries: number; maxEntries: number };
}
