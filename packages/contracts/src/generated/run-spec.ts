// Generated from los.run-spec@0.2.0 by tools/contract-codegen.ts. Do not edit.

import { createContractValidator } from '../runtime.js';

export const RUN_SPEC_CONTRACT = "los.run-spec";
export const RUN_SPEC_VERSION = "0.2.0";
export const RUN_SPEC_REQUEST_SCHEMA = {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["prompt"],"properties":{"prompt":{"type":"string","minLength":1},"provider":{"type":["string","null"]},"model":{"type":["string","null"]},"workspaceRoot":{"type":"string","description":"Absolute workspace path resolved by the receiving runtime."},"toolMode":{"type":"string","enum":["read-only","project-write","all"],"default":"project-write"},"allowedTools":{"type":"array","items":{"type":"string"}},"sandbox":{"type":"object","properties":{"mode":{"type":"string","enum":["read-only","workspace-write","unrestricted"]},"approvalPolicy":{"type":"string","enum":["never","on-request","on-failure"]}}},"sessionId":{"type":"string"},"parentSessionId":{"type":"string"},"traceId":{"type":"string"},"requestId":{"type":"string"},"tenantId":{"type":"string"},"projectId":{"type":"string"},"userId":{"type":"string"},"dedupeKey":{"type":"string"},"timeoutMs":{"type":"integer","minimum":1},"maxLoops":{"type":"integer","minimum":1},"attempt":{"type":"integer","minimum":1,"description":"Attempt number for a fresh task_run created from retry or recovery."},"executor":{"type":"object","properties":{"enabled":{"type":"boolean"},"nodeId":{"type":"string"},"leaseMs":{"type":"integer","minimum":1000},"heartbeatMs":{"type":"integer","minimum":1000},"requiredCapabilities":{"type":"array","description":"Capability requirements compiled from run intent before executor selection. The scheduler fails closed when no candidate satisfies every requirement.\n","uniqueItems":true,"items":{"type":"string","enum":["workspace_read","workspace_write","shell","sandbox","network_egress","heavy_task_safe","deploy_safe"]}}}},"status":{"type":"string","enum":["created","running","succeeded","failed","cancelled","blocked"],"description":"Durable run state. `blocked` is used when runtime completion is prevented by a required verifier or another operator-action gate.\n"},"runContract":{"type":"object","description":"Operator-provided execution contract. Includes mode, required checks, stop conditions, phase lifecycle, plan steps, and verification requirements. Standard and heavyweight approval requires a non-empty structured plan plus at least one required check or verification requirement. Phase transitions are enforced: created → discovering → discovery_ready → planning → plan_approved → executing → verifying → succeeded|blocked|failed|cancelled.\n","properties":{"mode":{"type":"string","enum":["audit","execution","closeout","governance","feed-analysis-ingress","architect-editor"]},"executionMode":{"type":"string","enum":["lightweight","standard","heavyweight"],"default":"standard"},"phase":{"type":"string","enum":["created","discovering","discovery_ready","planning","plan_approved","executing","verifying","succeeded","blocked","failed","cancelled"]},"previousPhase":{"type":"string","enum":["created","discovering","discovery_ready","planning","plan_approved","executing","verifying","succeeded","blocked","failed","cancelled"]},"phaseChangedAt":{"type":"string","format":"date-time"},"plan":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"},"dependsOnIds":{"type":"array","items":{"type":"string"}},"editableSurfaces":{"type":"array","items":{"type":"string"}},"completionCriteria":{"type":"string"}}}},"verifications":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["command","assertion","operator_review"]},"description":{"type":"string"},"command":{"type":"string"},"assertion":{"type":"string"},"reviewer":{"type":"string"}}}},"planRevision":{"type":"integer","minimum":1},"planParentRevision":{"type":"integer","minimum":1},"planParentRunSpecId":{"type":"string","description":"Parent run spec id when lineage crosses distinct runs; same-run revisions use planParentRevision."},"planHistory":{"type":"array","description":"Immutable snapshots of superseded plan revisions and verification mappings.","items":{"type":"object","required":["revision","plan","requiredChecks","verifications","supersededAt"],"properties":{"revision":{"type":"integer","minimum":1},"plan":{"type":"array","items":{"type":"object"}},"requiredChecks":{"type":"array","items":{"type":"string"}},"verifications":{"type":"array","items":{"type":"object"}},"supersededAt":{"type":"string","format":"date-time"},"actor":{"type":"string"},"reason":{"type":"string"}}}},"requiredChecks":{"type":"array","items":{"type":"string"}},"allowedSkippedChecks":{"type":"array","description":"Verification requirement ids that may satisfy the success gate with a skipped status.","items":{"type":"string"}},"stopConditions":{"type":"array","items":{"type":"string"}},"evidenceRequired":{"type":"array","items":{"type":"string"}},"commitBoundary":{"type":"string"}}}},"additionalProperties":true} as const;

export type RunSpecRequest = {
  prompt: string;
  provider?: string | null;
  model?: string | null;
  workspaceRoot?: string;
  toolMode?: "read-only" | "project-write" | "all";
  allowedTools?: Array<string>;
  sandbox?: {
    mode?: "read-only" | "workspace-write" | "unrestricted";
    approvalPolicy?: "never" | "on-request" | "on-failure";
  };
  sessionId?: string;
  parentSessionId?: string;
  traceId?: string;
  requestId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  dedupeKey?: string;
  timeoutMs?: number;
  maxLoops?: number;
  attempt?: number;
  executor?: {
    enabled?: boolean;
    nodeId?: string;
    leaseMs?: number;
    heartbeatMs?: number;
    requiredCapabilities?: Array<"workspace_read" | "workspace_write" | "shell" | "sandbox" | "network_egress" | "heavy_task_safe" | "deploy_safe">;
  };
  status?: "created" | "running" | "succeeded" | "failed" | "cancelled" | "blocked";
  runContract?: {
    mode?: "audit" | "execution" | "closeout" | "governance" | "feed-analysis-ingress" | "architect-editor";
    executionMode?: "lightweight" | "standard" | "heavyweight";
    phase?: "created" | "discovering" | "discovery_ready" | "planning" | "plan_approved" | "executing" | "verifying" | "succeeded" | "blocked" | "failed" | "cancelled";
    previousPhase?: "created" | "discovering" | "discovery_ready" | "planning" | "plan_approved" | "executing" | "verifying" | "succeeded" | "blocked" | "failed" | "cancelled";
    phaseChangedAt?: string;
    plan?: Array<{
      id?: string;
      title?: string;
      description?: string;
      dependsOnIds?: Array<string>;
      editableSurfaces?: Array<string>;
      completionCriteria?: string;
    }>;
    verifications?: Array<{
      id?: string;
      kind?: "command" | "assertion" | "operator_review";
      description?: string;
      command?: string;
      assertion?: string;
      reviewer?: string;
    }>;
    planRevision?: number;
    planParentRevision?: number;
    planParentRunSpecId?: string;
    planHistory?: Array<{
      revision: number;
      plan: Array<Record<string, unknown>>;
      requiredChecks: Array<string>;
      verifications: Array<Record<string, unknown>>;
      supersededAt: string;
      actor?: string;
      reason?: string;
    }>;
    requiredChecks?: Array<string>;
    allowedSkippedChecks?: Array<string>;
    stopConditions?: Array<string>;
    evidenceRequired?: Array<string>;
    commitBoundary?: string;
  };
};

export const validateRunSpecRequest = createContractValidator<RunSpecRequest>(
  RUN_SPEC_REQUEST_SCHEMA,
);
