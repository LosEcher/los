import type { StaticAnalysisFinding, StaticAnalysisScanResult } from '../static-analysis/types.js';

export interface StaticAnalysisEventPayload {
  project: string;
  filesScanned: number;
  totalFindings: number;
  ruleBreakdown: Record<string, number>;
  sampleFindings: Array<{
    ruleId: string;
    severity: string;
    file: string;
    excerpt: string;
    message: string;
  }>;
}

export function buildStaticAnalysisPayload(
  result: StaticAnalysisScanResult,
  project: string,
  maxSamples = 10,
): StaticAnalysisEventPayload {
  const ruleBreakdown: Record<string, number> = {};
  for (const f of result.findings) {
    ruleBreakdown[f.ruleId] = (ruleBreakdown[f.ruleId] || 0) + 1;
  }

  // Pick diverse samples: one per rule, up to maxSamples
  const seen = new Set<string>();
  const samples: StaticAnalysisEventPayload['sampleFindings'] = [];
  for (const f of result.findings) {
    if (samples.length >= maxSamples) break;
    if (!seen.has(f.ruleId)) {
      seen.add(f.ruleId);
      samples.push({
        ruleId: f.ruleId,
        severity: f.severity,
        file: f.file,
        excerpt: f.excerpt,
        message: f.message,
      });
    }
  }

  return {
    project,
    filesScanned: result.filesScanned,
    totalFindings: result.findings.length,
    ruleBreakdown,
    sampleFindings: samples,
  };
}
