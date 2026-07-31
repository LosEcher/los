// Generated from los.execution-pairwise-sample-gate@0.1.0 by tools/contract-codegen.ts. Do not edit.

import { createContractValidator } from '../runtime.js';

export const EXECUTION_PAIRWISE_SAMPLE_GATE_CONTRACT = "los.execution-pairwise-sample-gate";
export const EXECUTION_PAIRWISE_SAMPLE_GATE_VERSION = "0.1.0";
export const EXECUTION_PAIRWISE_SAMPLE_GATE_SCHEMA = {"type":"object","required":["id","minimumPairs","scenarios","baselineRef","candidateRef","rubricRef"],"properties":{"id":{"type":"string","minLength":1},"tenantId":{"type":"string"},"projectId":{"type":"string"},"minimumPairs":{"type":"integer","minimum":1},"scenarios":{"type":"array","minItems":1,"items":{"type":"object","required":["id","label","requiredPairs"],"additionalProperties":false,"properties":{"id":{"type":"string","minLength":1},"label":{"type":"string","minLength":1},"description":{"type":"string"},"requiredPairs":{"type":"integer","minimum":1}}}},"baselineRef":{"type":"object","required":["experimentId","runSpecId"],"additionalProperties":false,"properties":{"experimentId":{"type":"string","minLength":1},"runSpecId":{"type":"string","minLength":1}}},"candidateRef":{"type":"object","required":["experimentId","runSpecId"],"additionalProperties":false,"properties":{"experimentId":{"type":"string","minLength":1},"runSpecId":{"type":"string","minLength":1}}},"rubricRef":{"type":"object","required":["id","revision"],"additionalProperties":false,"properties":{"id":{"type":"string","minLength":1},"revision":{"type":"string","minLength":1}}},"status":{"type":"string","enum":["registered","passed","superseded","cancelled"]},"registeredBy":{"type":"string","minLength":1},"preregisteredAt":{"type":"string","format":"date-time"},"passedAt":{"type":"string","format":"date-time"}},"additionalProperties":false} as const;

export type ExecutionPairwiseSampleGateRequest = {
  id: string;
  tenantId?: string;
  projectId?: string;
  minimumPairs: number;
  scenarios: Array<{
    id: string;
    label: string;
    description?: string;
    requiredPairs: number;
  }>;
  baselineRef: {
    experimentId: string;
    runSpecId: string;
  };
  candidateRef: {
    experimentId: string;
    runSpecId: string;
  };
  rubricRef: {
    id: string;
    revision: string;
  };
  status?: "registered" | "passed" | "superseded" | "cancelled";
  registeredBy?: string;
  preregisteredAt?: string;
  passedAt?: string;
};

export const validateExecutionPairwiseSampleGateRequest = createContractValidator<ExecutionPairwiseSampleGateRequest>(
  EXECUTION_PAIRWISE_SAMPLE_GATE_SCHEMA,
);
