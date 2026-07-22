import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMediaActions } from './media-actions.js';
import { executeMediaOperation, persistMediaOutput } from './media-runtime.js';

const originalFetch = globalThis.fetch;

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'los-media-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function setEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('executeMediaOperation rejects unknown, unsupported, and unconfigured providers', async () => {
  assert.equal((await executeMediaOperation('unknown', 'tts.synthesize')).error, 'provider_unknown');
  assert.equal(
    (await executeMediaOperation('openai-tts', 'image.generate')).error,
    'unsupported_operation: image.generate',
  );

  const restore = setEnv('ELEVENLABS_API_KEY', undefined);
  try {
    const result = await executeMediaOperation('elevenlabs-tts', 'tts.synthesize', { text: 'hello' });
    assert.equal(result.error, 'missing_api_key');
    assert.deepEqual(result.raw, { missing: ['ELEVENLABS_API_KEY'] });
  } finally {
    restore();
  }
});

test('OpenAI TTS maps the HTTP request and persists the returned audio', async () => {
  const restore = setEnv('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.openai.com/v1/audio/speech');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: 'tts-1', input: 'hello', voice: 'alloy', response_format: 'wav',
    });
    return new Response(Buffer.from('audio-bytes'), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    });
  };

  try {
    const result = await executeMediaOperation('openai-tts', 'tts.synthesize', {
      text: 'hello', audioFormat: 'wav',
    });
    assert.equal(result.ok, true);
    assert.equal(result.contentType, 'audio/wav');

    await withTempDir(async outputDir => {
      const persisted = await persistMediaOutput(result, {
        outputDir, tenantId: 'tenant / one', accountId: 'account', peerId: 'peer',
      });
      assert.match(persisted.path, /tenant-one\/account\/peer\/\d{4}-\d{2}-\d{2}\//);
      assert.equal((await readFile(persisted.path)).toString(), 'audio-bytes');
      assert.equal(persisted.bytes, 11);
    });
  } finally {
    restore();
  }
});

test('persistMediaOutput writes base64 images and rejects invalid results', async () => {
  await assert.rejects(
    persistMediaOutput({ ok: false, providerId: 'openai-image', operation: 'image.generate' }),
    /media_result_not_persistable/,
  );

  await withTempDir(async outputDir => {
    const persisted = await persistMediaOutput({
      ok: true,
      providerId: 'openai-image',
      operation: 'image.generate',
      imageBase64: [`data:image/png;base64,${Buffer.from('image').toString('base64')}`],
      generationId: 'generation-1',
    }, { outputDir });
    assert.equal(persisted.count, 1);
    assert.equal(persisted.generationId, 'generation-1');
    assert.equal((await readFile(persisted.path)).toString(), 'image');
  });
});

test('media actions preserve execution errors and persist successful generation', async () => {
  const missing = await createMediaActions().generateVideo({ providerId: 'unknown', prompt: 'clip' });
  assert.deepEqual(missing, { ok: false, error: 'provider_unknown' });

  const restore = setEnv('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = async () => new Response(Buffer.from('voice'), { status: 200 });
  try {
    await withTempDir(async outputDir => {
      const result = await createMediaActions({ outputDir }).synthesizeTts({
        providerId: 'openai-tts', text: 'hello',
      });
      assert.equal(result.ok, true);
      assert.equal(result.persisted?.bytes, 5);
    });
  } finally {
    restore();
  }
});
