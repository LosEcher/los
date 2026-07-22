import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildImageDeliveryReply,
  buildTtsDeliveryReply,
  buildVideoDeliveryReply,
} from './media-delivery.js';
import type { MediaPersistResult } from './media-runtime.js';

function result(overrides: Partial<MediaPersistResult>): MediaPersistResult {
  return {
    path: '/tmp/output.bin',
    bytes: 1_536,
    contentType: 'application/octet-stream',
    providerId: 'openai-image',
    operation: 'image.generate',
    ...overrides,
  };
}

test('delivery replies expose persisted media with channel metadata', () => {
  const tts = buildTtsDeliveryReply(result({
    path: '/tmp/speech.mp3', providerId: 'openai-tts', operation: 'tts.synthesize',
  }));
  assert.match(tts.text, /1\.5 KB/);
  assert.deepEqual(tts.media, { type: 'audio', url: '/tmp/speech.mp3', fileName: 'speech.mp3' });

  const image = buildImageDeliveryReply(result({
    path: '/tmp/image-1.png', paths: ['/tmp/image-1.png', '/tmp/image-2.png'], count: 2,
  }));
  assert.match(image.text, /2 images in total/);
  assert.equal(image.media?.type, 'image');

  const video = buildVideoDeliveryReply(result({
    path: '/tmp/clip.mp4', providerId: 'minimax-video', operation: 'video.generate',
  }));
  assert.equal(video.media?.fileName, 'clip.mp4');
});

test('delivery replies do not attach manifest-only outputs', () => {
  assert.equal(buildTtsDeliveryReply(result({ manifestOnly: true })).media, undefined);
  assert.match(buildImageDeliveryReply(result({ manifestOnly: true, count: 3 })).text, /links only/);
  assert.match(buildVideoDeliveryReply(result({ manifestOnly: true })).text, /manifest only/);
});
