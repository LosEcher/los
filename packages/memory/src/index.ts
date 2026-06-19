/**
 * @los/memory — Public API.
 */

export {
  ensureMemoryStore,
  addObservation,
  getObservation,
  updateObservation,
  deleteObservation,
  searchObservations,
  getStats,
  listEntities,
  findRelatedObservations,
  findCooccurringEntities,
  type Observation,
  type MemoryStats,
  type EntityNode,
  type EntityCooccurrence,
  type EntitySearchOptions,
} from './core/store.js';

export type { ObserverType } from './types.js';

export { syncMemoryMd, readMemoryMd } from './markdown.js';

export {
  ensureMemoryCompactionStore,
  compactSession,
  getCompaction,
  listCompactions,
  attestCompaction,
  promoteCandidate,
  type MemoryCompaction,
  type CompactSessionInput,
  type ListCompactionsOptions,
  type ProceduralCandidate,
  type CandidateStatus,
} from './core/compaction.js';

export { getLatestCheckpoint } from './core/checkpoint.js';

export {
  retrieveActiveRules,
  formatRulesForPrompt,
  resolveMemoryLayers,
  routeMemoryRetrieval,
  augmentSystemPrompt,
  type ActiveRule,
  type RetrievalOptions,
  type RetrievalResult,
  type AugmentPromptResult,
  type TaskState,
  type RunPhase,
  type MemoryLayer,
} from './core/retrieval.js';

export {
  ensureProceduralCandidateStore,
  createProceduralCandidate,
  getProceduralCandidate,
  listProceduralCandidates,
  listActiveCandidates,
  promoteProceduralCandidate,
  deleteProceduralCandidate,
  type ProceduralCandidate as ProceduralCandidateRecord,
  type CreateProceduralCandidateInput,
  type ListProceduralCandidatesOptions,
} from './procedures/procedural-candidates.js';

export {
  recordSelfReflection,
  listSelfReflections,
  getAgentSelfInsights,
  type SelfReflectionInput,
  type AgentSelfInsight,
} from './reflection/self-reflection.js';

export {
  checkMemoryIntegrity,
  type MemoryIntegrityReport,
  type MemoryIntegrityCheck,
} from './core/integrity.js';

export {
  applyRetentionPolicy,
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
  type RetentionResult,
} from './core/retention.js';
