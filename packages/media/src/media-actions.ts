/**
 * @los/media/media-actions — Channel-facing media action wrappers.
 *
 * Simplified API for communication channels to generate and persist
 * media without knowing provider internals.
 *
 * Inspired by lsclaw's createWeixinMediaActions.
 */

import {
  executeMediaOperation,
  persistMediaOutput,
  type MediaOperationInput,
  type MediaOperationResult,
  type MediaPersistResult,
} from './media-runtime.js';
import type { MediaOperation } from './provider-catalog.js';

export interface MediaActionOptions {
  tenantId?: string;
  accountId?: string;
  peerId?: string;
  outputDir?: string;
}

export interface TtsActionInput {
  providerId: string;
  text: string;
  voiceId?: string;
  model?: string;
}

export interface ImageActionInput {
  providerId: string;
  prompt: string;
  aspectRatio?: string;
  n?: number;
}

export interface VideoActionInput {
  providerId: string;
  prompt: string;
  durationSeconds?: number;
}

export interface MediaActions {
  synthesizeTts(input: TtsActionInput): Promise<{ ok: boolean; error?: string; persisted?: MediaPersistResult }>;
  generateImage(input: ImageActionInput): Promise<{ ok: boolean; error?: string; persisted?: MediaPersistResult }>;
  generateVideo(input: VideoActionInput): Promise<{ ok: boolean; error?: string; persisted?: MediaPersistResult }>;
}

async function runAndPersist(
  run: () => Promise<MediaOperationResult>,
  opts: MediaActionOptions,
): Promise<{ ok: boolean; error?: string; persisted?: MediaPersistResult }> {
  const result = await run();
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  try {
    const persisted = await persistMediaOutput(result, {
      tenantId: opts.tenantId,
      accountId: opts.accountId,
      peerId: opts.peerId,
      outputDir: opts.outputDir,
    });
    return { ok: true, persisted };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function createMediaActions(opts: MediaActionOptions = {}): MediaActions {
  return {
    synthesizeTts(input: TtsActionInput) {
      return runAndPersist(
        () => executeMediaOperation(input.providerId, 'tts.synthesize', {
          text: input.text,
          voiceId: input.voiceId,
          model: input.model,
        }),
        opts,
      );
    },

    generateImage(input: ImageActionInput) {
      return runAndPersist(
        () => executeMediaOperation(input.providerId, 'image.generate', {
          prompt: input.prompt,
          aspectRatio: input.aspectRatio,
          responseFormat: 'url',
          promptOptimizer: true,
          n: input.n,
        }),
        opts,
      );
    },

    generateVideo(input: VideoActionInput) {
      return runAndPersist(
        () => executeMediaOperation(input.providerId, 'video.generate', {
          prompt: input.prompt,
          durationSeconds: input.durationSeconds,
          responseFormat: 'url',
        }),
        opts,
      );
    },
  };
}
