// Generated from los.run-spec@0.6.0 by tools/contract-codegen.ts. Do not edit.

import { createContractValidator } from '../runtime.js';

export const RUN_SPEC_CONTRACT = "los.run-spec";
export const RUN_SPEC_VERSION = "0.6.0";
export const RUN_SPEC_REQUEST_SCHEMA = {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["prompt"],"properties":{"prompt":{"type":"string","minLength":1},"provider":{"type":["string","null"]},"model":{"type":["string","null"]},"providerFallback":{"type":"object","required":["mode","targets"],"additionalProperties":false,"properties":{"mode":{"type":"string","const":"explicit_ordered"},"targets":{"type":"array","minItems":2,"maxItems":5,"items":{"type":"object","required":["provider"],"additionalProperties":false,"properties":{"provider":{"type":"string","minLength":1},"model":{"type":"string","minLength":1}}}},"onFailure":{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string","enum":["transport","rate_limit","provider_unavailable"]}},"requireCompatibilityEvidence":{"type":"boolean","default":true},"maxSwitches":{"type":"integer","minimum":1,"maximum":4}}},"workspaceRoot":{"type":"string","description":"Absolute workspace path resolved by the receiving runtime."},"toolMode":{"type":"string","enum":["read-only","project-write","all"],"default":"project-write"},"allowedTools":{"type":"array","items":{"type":"string"}},"planningTransport":{"type":"string","enum":["typed_tool","text_json_legacy"],"default":"typed_tool","description":"Planning submission carrier. typed_tool exposes the planning-only submit_run_contract protocol tool and is the default. text_json_legacy retains explicit compatibility for providers that cannot emit typed tool calls; it must not become the implicit planning path.\n"},"sandbox":{"type":"object","properties":{"mode":{"type":"string","enum":["read-only","workspace-write","unrestricted"]},"approvalPolicy":{"type":"string","enum":["never","on-request","on-failure"]}}},"sessionId":{"type":"string"},"parentSessionId":{"type":"string"},"traceId":{"type":"string"},"requestId":{"type":"string"},"tenantId":{"type":"string"},"projectId":{"type":"string"},"userId":{"type":"string"},"dedupeKey":{"type":"string"},"timeoutMs":{"type":"integer","minimum":1},"maxLoops":{"type":"integer","minimum":1},"attempt":{"type":"integer","minimum":1,"description":"Attempt number for a fresh task_run created from retry or recovery."},"executor":{"type":"object","properties":{"enabled":{"type":"boolean"},"nodeId":{"type":"string"},"leaseMs":{"type":"integer","minimum":1000},"heartbeatMs":{"type":"integer","minimum":1000},"requiredCapabilities":{"type":"array","description":"Capability requirements compiled from run intent before executor selection. The scheduler fails closed when no candidate satisfies every requirement.\n","uniqueItems":true,"items":{"type":"string","enum":["workspace_read","workspace_write","shell","sandbox","network_egress","heavy_task_safe","deploy_safe"]}}}},"status":{"type":"string","enum":["created","running","succeeded","failed","cancelled","blocked"],"description":"Durable run state. `blocked` is used when runtime completion is prevented by a required verifier or another operator-action gate.\n"},"runContract":{"type":"object","description":"Operator-provided execution contract. Includes mode, required checks, stop conditions, phase lifecycle, plan steps, and verification requirements. Standard and heavyweight approval requires a non-empty structured plan plus at least one required check or verification requirement. Phase transitions are enforced: created → discovering → discovery_ready → planning → plan_approved → executing → verifying → succeeded|blocked|failed|cancelled.\n","properties":{"mode":{"type":"string","enum":["audit","execution","closeout","governance","feed-analysis-ingress","architect-editor"]},"executionMode":{"type":"string","enum":["lightweight","standard","heavyweight"],"default":"standard"},"phase":{"type":"string","enum":["created","discovering","discovery_ready","planning","plan_approved","executing","verifying","succeeded","blocked","failed","cancelled"]},"previousPhase":{"type":"string","enum":["created","discovering","discovery_ready","planning","plan_approved","executing","verifying","succeeded","blocked","failed","cancelled"]},"phaseChangedAt":{"type":"string","format":"date-time"},"plan":{"type":"array","minItems":1,"items":{"type":"object","required":["id","title","description","dependsOnIds","editableSurfaces","completionCriteria"],"additionalProperties":false,"properties":{"id":{"type":"string","minLength":1},"title":{"type":"string","minLength":1},"description":{"type":"string","minLength":1},"dependsOnIds":{"type":"array","items":{"type":"string"}},"editableSurfaces":{"type":"array","items":{"type":"string"}},"completionCriteria":{"type":"string","minLength":1}}}},"verifications":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"kind":{"type":"string","enum":["command","assertion","operator_review"]},"description":{"type":"string"},"command":{"type":"string"},"assertion":{"type":"string"},"reviewer":{"type":"string"},"independence":{"type":"string","enum":["deterministic","separate_model","same_model","unknown"],"description":"How far this check's evidence stands from the executing model's own judgment. deterministic = machine-checked command/assertion; separate_model = reviewed by a different model/provider; same_model = executing model self-review; unknown = not declared (default). Required checks map to deterministic.\n"}}}},"planRevision":{"type":"integer","minimum":1},"recoveryPolicy":{"type":"string","enum":["automatic","explicit_only"],"description":"Crash/startup recovery policy. automatic (default) lets the gateway recovery scanner re-dispatch the run when no matching attempt exists; explicit_only excludes the run from automatic recovery so a gateway restart can never re-execute it (used by K4 execution experiments).\n"},"planParentRevision":{"type":"integer","minimum":1},"planParentRunSpecId":{"type":"string","description":"Parent run spec id when lineage crosses distinct runs; same-run revisions use planParentRevision."},"planHistory":{"type":"array","description":"Immutable snapshots of superseded plan revisions and verification mappings.","items":{"type":"object","required":["revision","plan","requiredChecks","verifications","supersededAt"],"properties":{"revision":{"type":"integer","minimum":1},"plan":{"type":"array","items":{"type":"object"}},"requiredChecks":{"type":"array","items":{"type":"string"}},"verifications":{"type":"array","items":{"type":"object"}},"supersededAt":{"type":"string","format":"date-time"},"actor":{"type":"string"},"reason":{"type":"string"}}}},"requiredChecks":{"type":"array","items":{"type":"string"}},"allowedSkippedChecks":{"type":"array","description":"Verification requirement ids that may satisfy the success gate with a skipped status.","items":{"type":"string"}},"stopConditions":{"type":"array","items":{"type":"string"}},"evidenceRequired":{"type":"array","items":{"type":"string"}},"commitBoundary":{"type":"string"},"executionKernel":{"type":"object","description":"Explicit per-run execution-kernel selection. K4 candidates bind the exact adapter identity, owning execution experiment, read-only disposition, separate canary authorization, and rollback history.\n","required":["selectionMode","experimentId","disposition","requested","selected","rollback","canaryAuthorization","history"],"additionalProperties":false,"properties":{"selectionMode":{"type":"string","const":"explicit"},"experimentId":{"type":"string","minLength":1},"disposition":{"type":"string","enum":["planning","inspection"]},"requested":{"type":"object","required":["kind","version","protocolVersion"],"additionalProperties":false,"properties":{"kind":{"type":"string","minLength":1},"version":{"type":"string","minLength":1},"protocolVersion":{"type":"string","minLength":1}}},"selected":{"type":"object","required":["kind","version","protocolVersion"],"additionalProperties":false,"properties":{"kind":{"type":"string","minLength":1},"version":{"type":"string","minLength":1},"protocolVersion":{"type":"string","minLength":1}}},"rollback":{"type":"object","required":["target","status"],"additionalProperties":false,"properties":{"target":{"type":"object","required":["kind","version","protocolVersion"],"additionalProperties":false,"properties":{"kind":{"type":"string","minLength":1},"version":{"type":"string","minLength":1},"protocolVersion":{"type":"string","minLength":1}}},"status":{"type":"string","enum":["available","applied"]},"appliedAt":{"type":"string","format":"date-time"},"appliedBy":{"type":"string"},"reason":{"type":"string"}}},"canaryAuthorization":{"type":"object","required":["status"],"additionalProperties":false,"properties":{"status":{"type":"string","enum":["not_granted","granted"]},"grantedAt":{"type":"string","format":"date-time"},"grantedBy":{"type":"string"}}},"history":{"type":"array","minItems":1,"items":{"type":"object","required":["action","to","actor","at"],"additionalProperties":false,"properties":{"action":{"type":"string","enum":["selected","rollback"]},"from":{"type":"object","required":["kind","version","protocolVersion"],"additionalProperties":false,"properties":{"kind":{"type":"string","minLength":1},"version":{"type":"string","minLength":1},"protocolVersion":{"type":"string","minLength":1}}},"to":{"type":"object","required":["kind","version","protocolVersion"],"additionalProperties":false,"properties":{"kind":{"type":"string","minLength":1},"version":{"type":"string","minLength":1},"protocolVersion":{"type":"string","minLength":1}}},"actor":{"type":"string","minLength":1},"at":{"type":"string","format":"date-time"},"reason":{"type":"string"}}}}}}}}},"additionalProperties":true} as const;

export type RunSpecRequest = {
  prompt: string;
  provider?: string | null;
  model?: string | null;
  providerFallback?: {
    mode: string;
    targets: Array<{
      provider: string;
      model?: string;
    }>;
    onFailure?: Array<"transport" | "rate_limit" | "provider_unavailable">;
    requireCompatibilityEvidence?: boolean;
    maxSwitches?: number;
  };
  workspaceRoot?: string;
  toolMode?: "read-only" | "project-write" | "all";
  allowedTools?: Array<string>;
  planningTransport?: "typed_tool" | "text_json_legacy";
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
      id: string;
      title: string;
      description: string;
      dependsOnIds: Array<string>;
      editableSurfaces: Array<string>;
      completionCriteria: string;
    }>;
    verifications?: Array<{
      id?: string;
      kind?: "command" | "assertion" | "operator_review";
      description?: string;
      command?: string;
      assertion?: string;
      reviewer?: string;
      independence?: "deterministic" | "separate_model" | "same_model" | "unknown";
    }>;
    planRevision?: number;
    recoveryPolicy?: "automatic" | "explicit_only";
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
    executionKernel?: {
      selectionMode: string;
      experimentId: string;
      disposition: "planning" | "inspection";
      requested: {
        kind: string;
        version: string;
        protocolVersion: string;
      };
      selected: {
        kind: string;
        version: string;
        protocolVersion: string;
      };
      rollback: {
        target: {
          kind: string;
          version: string;
          protocolVersion: string;
        };
        status: "available" | "applied";
        appliedAt?: string;
        appliedBy?: string;
        reason?: string;
      };
      canaryAuthorization: {
        status: "not_granted" | "granted";
        grantedAt?: string;
        grantedBy?: string;
      };
      history: Array<{
        action: "selected" | "rollback";
        from?: {
          kind: string;
          version: string;
          protocolVersion: string;
        };
        to: {
          kind: string;
          version: string;
          protocolVersion: string;
        };
        actor: string;
        at: string;
        reason?: string;
      }>;
    };
  };
};

export const validateRunSpecRequest = createContractValidator<RunSpecRequest>(
  RUN_SPEC_REQUEST_SCHEMA,
);
