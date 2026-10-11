/**
 * Session-recovery contract constants.
 *
 * This is the **reader's** current checkpoint format version, and it lives here
 * because two packages need it: `@los/agent` (which writes and validates
 * checkpoints) and `@los/memory` (which rebuilds compaction state from them).
 * It cannot live in the agent package — memory must not depend on the agent — and
 * it must not be duplicated as a literal, or the two readers can disagree about
 * which checkpoints are readable.
 *
 * Bound to `contracts/session-recovery.yaml` (`checkpoint.version`, minimum 1):
 * bump this only together with that schema, since a newer checkpoint is supposed
 * to degrade recovery rather than fail hard.
 */
export const CHECKPOINT_VERSION = 1;
