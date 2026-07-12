import type { ExecutionMode } from '../run-contract.js';
import {
  FeedAnalysisError,
  type FeedAnalysisDispatchRequest,
  type FeedAnalysisOutputKind,
  type FeedAnalysisScenario,
  type FeedAnalysisWorkflowProfile,
} from './feed-analysis-types.js';

export interface FeedAnalysisWorkflowDescriptor {
  scenario?: FeedAnalysisScenario;
  profile: FeedAnalysisWorkflowProfile;
  workflowId: string;
  workflowVersion: string;
  promptId: string;
  promptVersion: string;
  maxLoops: number;
  executionMode: ExecutionMode;
  allowsExternalResearch: boolean;
}

const WORKFLOWS: Record<FeedAnalysisWorkflowProfile, Omit<FeedAnalysisWorkflowDescriptor, 'scenario' | 'maxLoops'>> = {
  batch_summary: {
    profile: 'batch_summary',
    workflowId: 'lot2.batch-summary',
    workflowVersion: '1.0.0',
    promptId: 'lot2.batch-summary.generate',
    promptVersion: '1.0.0',
    executionMode: 'lightweight',
    allowsExternalResearch: false,
  },
  daily_content: {
    profile: 'daily_content',
    workflowId: 'lot2.daily-content',
    workflowVersion: '1.0.0',
    promptId: 'lot2.daily-content.generate',
    promptVersion: '1.0.0',
    executionMode: 'lightweight',
    allowsExternalResearch: false,
  },
  research_deep: {
    profile: 'research_deep',
    workflowId: 'lot2.research-topic',
    workflowVersion: '1.0.0',
    promptId: 'lot2.research-topic.generate',
    promptVersion: '1.0.0',
    executionMode: 'lightweight',
    allowsExternalResearch: true,
  },
};

const BATCH_OUTPUTS = new Set<FeedAnalysisOutputKind>(['daily_digest', 'content_brief']);

export function resolveFeedAnalysisWorkflow(
  request: FeedAnalysisDispatchRequest,
  itemCount: number,
  requestedOutputs: FeedAnalysisOutputKind[],
  allowExternalResearch: boolean,
): FeedAnalysisWorkflowDescriptor {
  const scenario = normalizeScenario(request.scenario);
  const requestedProfile = normalizeProfile(request.workflowHint?.profile);
  const profile = requestedProfile ?? defaultProfile(scenario);
  validateScenarioContext(request, scenario, itemCount);
  validateProfileCompatibility(scenario, profile, requestedOutputs);

  const workflow = WORKFLOWS[profile];
  if (allowExternalResearch && !workflow.allowsExternalResearch) {
    throw new FeedAnalysisError('capability_unsupported', `${profile} does not allow external research`, 422);
  }

  return {
    ...workflow,
    scenario,
    maxLoops: resolveMaxLoops(request.workflowHint?.maxLoops, profile),
  };
}

function normalizeScenario(value: unknown): FeedAnalysisScenario | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'evidence_batch' || value === 'research_topic') return value;
  throw new FeedAnalysisError('capability_unsupported', `scenario ${String(value)} is unsupported`, 422);
}

function normalizeProfile(value: unknown): FeedAnalysisWorkflowProfile | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'batch_summary' || value === 'daily_content' || value === 'research_deep') return value;
  throw new FeedAnalysisError('capability_unsupported', `workflow profile ${String(value)} is unsupported`, 422);
}

function defaultProfile(scenario: FeedAnalysisScenario | undefined): FeedAnalysisWorkflowProfile {
  if (scenario === 'evidence_batch') return 'batch_summary';
  if (scenario === 'research_topic') return 'research_deep';
  return 'daily_content';
}

function validateScenarioContext(
  request: FeedAnalysisDispatchRequest,
  scenario: FeedAnalysisScenario | undefined,
  itemCount: number,
): void {
  if (!scenario) return;
  const snapshot = request.collectionSnapshot;
  if (!snapshot?.snapshotId?.trim() || !Number.isInteger(snapshot.observationCount) || snapshot.observationCount < 1) {
    throw new FeedAnalysisError('invalid_request', `${scenario} requires a valid collectionSnapshot`, 400);
  }
  if (snapshot.observationCount !== itemCount) {
    throw new FeedAnalysisError('material_invalid', 'collectionSnapshot observationCount does not match material items', 422);
  }
  if (scenario === 'research_topic' && (!request.topic?.topicId?.trim() || !request.topic.title?.trim())) {
    throw new FeedAnalysisError('invalid_request', 'research_topic requires topicId and title', 400);
  }
}

function validateProfileCompatibility(
  scenario: FeedAnalysisScenario | undefined,
  profile: FeedAnalysisWorkflowProfile,
  requestedOutputs: FeedAnalysisOutputKind[],
): void {
  if (!scenario && profile !== 'daily_content') {
    throw new FeedAnalysisError('invalid_request', 'scenario is required when selecting a non-legacy workflow profile', 400);
  }
  if (scenario === 'evidence_batch' && profile !== 'batch_summary') {
    throw new FeedAnalysisError('capability_unsupported', `${profile} is not supported for evidence_batch`, 422);
  }
  if (scenario === 'research_topic' && profile === 'batch_summary') {
    throw new FeedAnalysisError('capability_unsupported', 'batch_summary is not supported for research_topic', 422);
  }
  if (profile === 'batch_summary' && requestedOutputs.some(output => !BATCH_OUTPUTS.has(output))) {
    throw new FeedAnalysisError('capability_unsupported', 'batch_summary supports daily_digest and content_brief only', 422);
  }
}

function resolveMaxLoops(value: unknown, profile: FeedAnalysisWorkflowProfile): number {
  const defaultValue = 1;
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 5) {
    throw new FeedAnalysisError('invalid_request', 'workflowHint.maxLoops must be an integer between 1 and 5', 400);
  }
  if (profile !== 'research_deep' && Number(value) !== 1) {
    throw new FeedAnalysisError('capability_unsupported', `${profile} only supports maxLoops=1`, 422);
  }
  return Number(value);
}
