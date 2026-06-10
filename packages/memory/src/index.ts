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
  type Observation,
  type MemoryStats,
} from './store.js';

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
} from './compaction.js';

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
} from './retrieval.js';
