// Generated from los.execution-experiment@0.1.0 by tools/contract-codegen.ts. Do not edit.

import { createContractValidator } from '../runtime.js';

export const EXECUTION_EXPERIMENT_CONTRACT = "los.execution-experiment";
export const EXECUTION_EXPERIMENT_VERSION = "0.1.0";
export const EXECUTION_EXPERIMENT_SCHEMA = {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["id","source","configDiff","status","createdBy"],"properties":{"id":{"type":"string","minLength":1},"tenantId":{"type":"string"},"projectId":{"type":"string"},"source":{"type":"object","required":["sessionId","runSpecId","eventCursor","evidenceHash"],"additionalProperties":false,"properties":{"sessionId":{"type":"string","minLength":1},"runSpecId":{"type":"string","minLength":1},"eventCursor":{"type":"integer","minimum":0},"evidenceHash":{"type":"string","minLength":1},"fingerprint":{"type":"object","additionalProperties":false,"properties":{"prompt":{"type":"string"},"spec":{"type":"string"},"memory":{"type":"string"},"toolCatalog":{"type":"string"}}}}},"configDiff":{"type":"array","items":{"type":"object","required":["path","value"],"additionalProperties":false,"properties":{"path":{"type":"string","minLength":1},"value":{},"inherited":{"type":"boolean"}}}},"candidateRunSpecId":{"type":"string"},"status":{"type":"string","enum":["draft","approved","running","succeeded","failed","cancelled","blocked"]},"createdBy":{"type":"string","minLength":1},"approvedBy":{"type":"string"},"createdAt":{"type":"string","format":"date-time"},"updatedAt":{"type":"string","format":"date-time"}},"additionalProperties":true} as const;

export type ExecutionExperimentRequest = {
  id: string;
  tenantId?: string;
  projectId?: string;
  source: {
    sessionId: string;
    runSpecId: string;
    eventCursor: number;
    evidenceHash: string;
    fingerprint?: {
      prompt?: string;
      spec?: string;
      memory?: string;
      toolCatalog?: string;
    };
  };
  configDiff: Array<{
    path: string;
    value: unknown;
    inherited?: boolean;
  }>;
  candidateRunSpecId?: string;
  status: "draft" | "approved" | "running" | "succeeded" | "failed" | "cancelled" | "blocked";
  createdBy: string;
  approvedBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export const validateExecutionExperimentRequest = createContractValidator<ExecutionExperimentRequest>(
  EXECUTION_EXPERIMENT_SCHEMA,
);
