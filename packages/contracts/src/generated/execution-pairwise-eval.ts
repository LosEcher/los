// Generated from los.execution-pairwise-eval@0.1.0 by tools/contract-codegen.ts. Do not edit.

import { createContractValidator } from '../runtime.js';

export const EXECUTION_PAIRWISE_EVAL_CONTRACT = "los.execution-pairwise-eval";
export const EXECUTION_PAIRWISE_EVAL_VERSION = "0.1.0";
export const EXECUTION_PAIRWISE_EVAL_SCHEMA = {"type":"object","required":["experimentId","baselineRunSpecId","candidateRunSpecId","rubricRevision","rubricSnapshot","verdict"],"properties":{"experimentId":{"type":"string","minLength":1},"baselineRunSpecId":{"type":"string","minLength":1},"candidateRunSpecId":{"type":"string","minLength":1},"rubricRevision":{"type":"string","minLength":1},"rubricSnapshot":{"type":"object","required":["id","revision","criteria"],"properties":{"id":{"type":"string","minLength":1},"revision":{"type":"string","minLength":1},"criteria":{"type":"array","items":{"type":"object","required":["id","label","maxScore"],"properties":{"id":{"type":"string","minLength":1},"label":{"type":"string","minLength":1},"description":{"type":"string"},"maxScore":{"type":"number","minimum":1}}}}}},"verdict":{"enum":["baseline","candidate","tie","inconclusive"]},"human":{"type":"object","properties":{"source":{"type":"string","minLength":1},"verdict":{"enum":["baseline","candidate","tie","inconclusive"]},"criterionScores":{"type":"array","items":{"type":"object"}},"note":{"type":"string"}}},"judge":{"type":"object","properties":{"source":{"type":"string","minLength":1},"verdict":{"enum":["baseline","candidate","tie","inconclusive"]},"criterionScores":{"type":"array","items":{"type":"object"}},"confidence":{"type":"number","minimum":0,"maximum":1}}},"deterministic":{"type":"object","properties":{"source":{"type":"string","minLength":1},"verdict":{"enum":["baseline","candidate","tie","inconclusive"]},"criterionScores":{"type":"array","items":{"type":"object"}},"verificationStatus":{"enum":["pending","succeeded","failed","skipped"]}}}},"additionalProperties":false} as const;

export type ExecutionPairwiseEvalRequest = {
  experimentId: string;
  baselineRunSpecId: string;
  candidateRunSpecId: string;
  rubricRevision: string;
  rubricSnapshot: {
    id: string;
    revision: string;
    criteria: Array<{
      id: string;
      label: string;
      description?: string;
      maxScore: number;
    }>;
  };
  verdict: "baseline" | "candidate" | "tie" | "inconclusive";
  human?: {
    source?: string;
    verdict?: "baseline" | "candidate" | "tie" | "inconclusive";
    criterionScores?: Array<Record<string, unknown>>;
    note?: string;
  };
  judge?: {
    source?: string;
    verdict?: "baseline" | "candidate" | "tie" | "inconclusive";
    criterionScores?: Array<Record<string, unknown>>;
    confidence?: number;
  };
  deterministic?: {
    source?: string;
    verdict?: "baseline" | "candidate" | "tie" | "inconclusive";
    criterionScores?: Array<Record<string, unknown>>;
    verificationStatus?: "pending" | "succeeded" | "failed" | "skipped";
  };
};

export const validateExecutionPairwiseEvalRequest = createContractValidator<ExecutionPairwiseEvalRequest>(
  EXECUTION_PAIRWISE_EVAL_SCHEMA,
);
