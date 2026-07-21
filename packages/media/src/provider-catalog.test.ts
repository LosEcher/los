import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getProviderCatalog,
  getProviderCatalogFlat,
  getProviderDefinition,
  inferAudioMime,
  inferImageMime,
  inferMediaKind,
  inferVideoMime,
  listAvailableProviders,
  resolveApiKey,
} from './index.js';

test('provider catalog groups providers and resolves definitions', () => {
  const catalog = getProviderCatalog();
  const flat = getProviderCatalogFlat();

  assert.equal(flat.length, 7);
  assert.deepEqual(
    Object.fromEntries(Object.entries(catalog).map(([kind, providers]) => [kind, providers.length])),
    { tts: 3, asr: 1, image: 2, video: 1 },
  );
  assert.equal(getProviderDefinition(' openai-tts ')?.defaultModel, 'tts-1');
  assert.equal(getProviderDefinition('unknown'), null);
});

test('provider availability uses explicit primary and fallback keys', () => {
  const minimax = getProviderDefinition('minimax-tts');
  assert.ok(minimax);
  assert.equal(resolveApiKey(minimax, { MINIMAX_MEDIA_API_KEY: ' primary ' }), 'primary');
  assert.equal(resolveApiKey(minimax, { MINIMAX_MEDIA_API_KEY: '', MINIMAX_API_KEY: ' fallback ' }), 'fallback');

  const available = listAvailableProviders({
    MINIMAX_MEDIA_API_KEY: '',
    MINIMAX_API_KEY: '',
    ELEVENLABS_API_KEY: 'eleven',
    OPENAI_API_KEY: '',
  });
  assert.deepEqual(available.map(provider => provider.id), ['elevenlabs-tts']);
});

test('media kind and MIME helpers normalize supported formats', () => {
  assert.equal(inferMediaKind('asr.transcribe'), 'asr');
  assert.equal(inferMediaKind('image.generate'), 'image');
  assert.equal(inferMediaKind('video.generate'), 'video');
  assert.equal(inferAudioMime(' WAV '), 'audio/wav');
  assert.equal(inferImageMime('jpeg'), 'image/jpeg');
  assert.equal(inferVideoMime('quicktime'), 'video/quicktime');
  assert.equal(inferAudioMime('unknown', 'audio/custom'), 'audio/custom');
});
