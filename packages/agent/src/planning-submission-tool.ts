import type { ToolRegistry } from './tools/core/registry.js';
import { readRunContractMetadata } from './run-contract.js';
import {
  _PLANNING_SUBMISSION_TOOL_NAME,
  validatePlanningOutputPayload,
  type PlanningOutput,
} from './planning-output.js';

export interface PlanningSubmissionCollector {
  getSubmission(): PlanningOutput | undefined;
}

export function registerPlanningSubmissionTool(
  registry: ToolRegistry,
  runContractMetadata?: Record<string, unknown>,
): PlanningSubmissionCollector {
  let submission: PlanningOutput | undefined;
  const runContract = readRunContractMetadata(runContractMetadata ?? {});
  registry.register(_PLANNING_SUBMISSION_TOOL_NAME, async args => {
    if (submission) {
      return {
        content: '',
        error: 'Planning submission already accepted for this attempt',
      };
    }
    try {
      submission = validatePlanningOutputPayload(args, runContract);
      return {
        content: JSON.stringify({
          accepted: true,
          planStepCount: submission.plan.length,
          verificationCount: submission.verifications.length,
        }),
      };
    } catch (error) {
      return {
        content: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, {
    type: 'function',
    function: {
      name: _PLANNING_SUBMISSION_TOOL_NAME,
      description: 'Submit one validated RunContract plan for operator approval. LOS injects all trusted execution identifiers.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['plan', 'verifications'],
        properties: {
          summary: { type: 'string' },
          plan: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'description', 'dependsOnIds', 'editableSurfaces', 'completionCriteria'],
              properties: {
                id: { type: 'string', minLength: 1 },
                title: { type: 'string', minLength: 1 },
                description: { type: 'string', minLength: 1 },
                dependsOnIds: { type: 'array', items: { type: 'string' } },
                editableSurfaces: { type: 'array', items: { type: 'string' } },
                completionCriteria: { type: 'string', minLength: 1 },
              },
            },
          },
          verifications: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'kind', 'description', 'command'],
              properties: {
                id: { type: 'string', minLength: 1 },
                kind: { type: 'string', enum: ['command'] },
                description: { type: 'string', minLength: 1 },
                command: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['run_contract:submit'],
    timeoutMs: 30_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: false,
    tags: ['protocol', 'planning'],
  });
  return {
    getSubmission: () => submission,
  };
}
