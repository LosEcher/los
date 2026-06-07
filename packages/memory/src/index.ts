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
  type MemoryCompaction,
  type CompactSessionInput,
  type ListCompactionsOptions,
} from './compaction.js';
