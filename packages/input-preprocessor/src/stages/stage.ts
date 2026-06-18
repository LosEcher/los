/**
 * @los/input-preprocessor/stages/stage — Pipeline stage interface.
 *
 * Each stage transforms PreprocessEntry[] → PreprocessEntry[],
 * mutating the shared StageContext (including SafetyReport) as a side channel.
 */

import type { StageInput, StageOutput } from '../types.js';

export interface PreprocessStage {
  /** Execute this stage, transforming entries and accumulating safety data. */
  execute(input: StageInput): StageOutput;
  /** Unique stage name for audit trails. */
  readonly name: string;
}
