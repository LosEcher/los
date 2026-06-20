/**
 * @los/media/media-delivery — Channel-specific media delivery formatting.
 *
 * Translates media generation results into channel messages with
 * media attachments. Handles channel-specific constraints:
 *   - WeChat: HTML links + file references
 *   - Web: direct URL references
 *
 * Inspired by lsclaw's weixin/media-delivery.mjs.
 */

import { basename } from 'node:path';
import type { MediaPersistResult } from './media-runtime.js';

export interface ChannelMediaReply {
  text: string;
  media?: {
    type: 'image' | 'video' | 'audio' | 'file';
    url: string;
    fileName?: string;
  };
}

// ── TTS delivery ─────────────────────────────────────────────────

export function buildTtsDeliveryReply(result: MediaPersistResult, options?: { deliveryMode?: string }): ChannelMediaReply {
  const providerLabel = result.providerId.replace(/-tts$/, '');
  const sizeStr = result.bytes > 0 ? ` (${formatSize(result.bytes)})` : '';

  if (result.manifestOnly) {
    return { text: `🎵 TTS [${providerLabel}] generated but could not be delivered as audio.${sizeStr}` };
  }

  return {
    text: `🎵 TTS [${providerLabel}] ready${sizeStr}`,
    media: {
      type: 'audio',
      url: result.path,
      fileName: basename(result.path),
    },
  };
}

// ── Image delivery ─────────────────────────────────────────────────

export function buildImageDeliveryReply(result: MediaPersistResult, options?: { deliveryMode?: string }): ChannelMediaReply {
  const providerLabel = result.providerId.replace(/-image$/, '');
  const countStr = (result.count ?? 1) > 1 ? ` ×${result.count}` : '';

  if (result.manifestOnly) {
    return { text: `📷 Image [${providerLabel}]${countStr} generated (links only). Check dashboard for details.` };
  }

  const texts = [`📷 Image [${providerLabel}]${countStr} generated.`];
  if (result.paths && result.paths.length > 1) {
    texts.push(`${result.paths.length} images in total.`);
  }

  return {
    text: texts.join(' '),
    media: {
      type: 'image',
      url: result.path,
      fileName: basename(result.path),
    },
  };
}

// ── Video delivery ─────────────────────────────────────────────────

export function buildVideoDeliveryReply(result: MediaPersistResult, options?: { deliveryMode?: string }): ChannelMediaReply {
  const providerLabel = result.providerId.replace(/-video$/, '');

  if (result.manifestOnly) {
    return { text: `🎬 Video [${providerLabel}] generated (manifest only). Check dashboard for details.` };
  }

  return {
    text: `🎬 Video [${providerLabel}] ready.`,
    media: {
      type: 'video',
      url: result.path,
      fileName: basename(result.path),
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
