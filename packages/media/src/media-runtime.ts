/**
 * @los/media/media-runtime — Execute and persist media operations.
 *
 * Each operation is dispatched to the correct provider implementation.
 * Results are persisted to local filesystem for delivery via channels.
 *
 * Inspired by lsclaw's media-runtime.mjs — executeCommunicationMediaOperation
 * and persistCommunicationMediaOutput.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getProviderDefinition,
  resolveApiKey,
  inferAudioMime,
  inferImageMime,
  inferVideoMime,
  type MediaOperation,
  type MediaProviderDefinition,
} from './provider-catalog.js';

// ── Types ─────────────────────────────────────────────────────────

export interface MediaOperationInput {
  text?: string;
  prompt?: string;
  filePath?: string;
  path?: string;
  voiceId?: string;
  model?: string;
  responseFormat?: 'url' | 'base64';
  aspectRatio?: string;
  n?: number;
  durationSeconds?: number;
  outputFormat?: string;
  audioFormat?: string;
  [key: string]: unknown;
}

export interface MediaOperationResult {
  ok: boolean;
  providerId: string;
  operation: MediaOperation;
  error?: string;
  // TTS
  audioBuffer?: Buffer;
  audioUrl?: string;
  audioHex?: string;
  audioFormat?: string;
  contentType?: string;
  voiceId?: string;
  model?: string;
  // Image
  imageBase64?: string[];
  imageUrls?: string[];
  // Video
  videoBase64?: string[];
  videoUrls?: string[];
  videoFormat?: string;
  // Metadata
  traceId?: string;
  generationId?: string;
  raw?: unknown;
}

export interface MediaPersistResult {
  path: string;
  /** Multiple output paths (for multi-image generation) */
  paths?: string[];
  /** Number of generated items */
  count?: number;
  bytes: number;
  contentType: string;
  providerId: string;
  operation: MediaOperation;
  generationId?: string;
  /** Couldn't download — only manifest saved */
  manifestOnly?: boolean;
  sourceUrl?: string;
}

export interface MediaPersistOptions {
  tenantId?: string;
  accountId?: string;
  peerId?: string;
  outputDir?: string;
  env?: Record<string, string | undefined>;
}

// ── Execute ───────────────────────────────────────────────────────

export async function executeMediaOperation(
  providerId: string,
  operation: MediaOperation,
  input: MediaOperationInput = {},
): Promise<MediaOperationResult> {
  const provider = getProviderDefinition(providerId);
  if (!provider) {
    return { ok: false, providerId, operation, error: 'provider_unknown' };
  }
  if (!provider.operations.includes(operation)) {
    return { ok: false, providerId, operation, error: `unsupported_operation: ${operation}` };
  }

  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    return { ok: false, providerId, operation, error: 'missing_api_key', raw: { missing: [provider.apiKeyEnv] } };
  }

  if (providerId === 'minimax-tts' && operation === 'tts.synthesize') {
    return executeMiniMaxTts(provider, input, apiKey);
  }
  if (providerId === 'elevenlabs-tts' && operation === 'tts.synthesize') {
    return executeElevenLabsTts(provider, input, apiKey);
  }
  if (providerId === 'openai-tts' && operation === 'tts.synthesize') {
    return executeOpenAITts(provider, input, apiKey);
  }
  if (providerId === 'minimax-image' && operation === 'image.generate') {
    return executeMiniMaxImage(provider, input, apiKey);
  }
  if (providerId === 'openai-image' && operation === 'image.generate') {
    return executeOpenAIImage(provider, input, apiKey);
  }
  if (providerId === 'minimax-video' && operation === 'video.generate') {
    return executeMiniMaxVideo(provider, input, apiKey);
  }

  return { ok: false, providerId, operation, error: 'unsupported_provider_operation' };
}

// ── Persist ───────────────────────────────────────────────────────

const DEFAULT_OUTPUT_DIR = resolve(process.cwd(), '.los-runtime', 'media');

export async function persistMediaOutput(
  result: MediaOperationResult,
  options: MediaPersistOptions = {},
): Promise<MediaPersistResult> {
  if (!result.ok) throw new Error('media_result_not_persistable');

  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const tenantId = sanitize(options.tenantId ?? 'default');
  const accountId = sanitize(options.accountId ?? 'account');
  const peerId = sanitize(options.peerId ?? 'peer');
  const providerId = sanitize(result.providerId);
  const baseDir = resolve(outputDir, tenantId, accountId, peerId, datePart);
  await mkdir(baseDir, { recursive: true });

  if (result.operation === 'tts.synthesize') return persistTts(result, baseDir);
  if (result.operation === 'image.generate') return persistImage(result, baseDir);
  if (result.operation === 'video.generate') return persistVideo(result, baseDir);

  throw new Error(`unsupported_persist_operation: ${result.operation}`);
}

// ── Provider implementations ──────────────────────────────────────

async function executeMiniMaxTts(
  provider: MediaProviderDefinition,
  input: MediaOperationInput,
  apiKey: string,
): Promise<MediaOperationResult> {
  const text = (input.text ?? '').trim();
  if (!text) return { ok: false, providerId: provider.id, operation: 'tts.synthesize', error: 'text_required' };

  const voiceId = (input.voiceId ?? process.env.MINIMAX_TTS_VOICE_ID ?? '').trim();
  if (!voiceId) return { ok: false, providerId: provider.id, operation: 'tts.synthesize', error: 'voice_id_required' };

  const model = (input.model ?? provider.defaultModel)!;
  const outputFormat = (input.outputFormat ?? 'hex').trim();
  const audioFormat = (input.audioFormat ?? 'mp3').trim();

  const body = {
    model,
    text,
    stream: false,
    voice_setting: { voice_id: voiceId },
    audio_setting: { format: audioFormat },
    output_format: outputFormat,
  };

  const res = await fetch(`${provider.baseUrl}/v1/t2a_v2`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = await res.json() as Record<string, unknown>;
  if (!res.ok || (payload?.base_resp as any)?.status_code !== 0) {
    return { ok: false, providerId: provider.id, operation: 'tts.synthesize', error: 'api_error', raw: payload };
  }

  const data = payload?.data as Record<string, unknown> | undefined;
  const audioValue = (data?.audio ?? '') as string;
  return {
    ok: true,
    providerId: provider.id,
    operation: 'tts.synthesize',
    model,
    voiceId,
    audioFormat,
    audioBuffer: outputFormat === 'hex' && audioValue ? Buffer.from(audioValue, 'hex') : undefined,
    audioHex: outputFormat === 'hex' ? audioValue : undefined,
    audioUrl: outputFormat === 'url' ? audioValue : undefined,
    contentType: inferAudioMime(audioFormat),
    traceId: (payload?.trace_id as string) ?? undefined,
    raw: payload,
  };
}

async function executeElevenLabsTts(
  provider: MediaProviderDefinition,
  input: MediaOperationInput,
  apiKey: string,
): Promise<MediaOperationResult> {
  const text = (input.text ?? '').trim();
  if (!text) return { ok: false, providerId: provider.id, operation: 'tts.synthesize', error: 'text_required' };

  const voiceId = (input.voiceId ?? process.env.ELEVENLABS_TTS_VOICE_ID ?? '').trim();
  if (!voiceId) return { ok: false, providerId: provider.id, operation: 'tts.synthesize', error: 'voice_id_required' };

  const modelId = (input.model ?? provider.defaultModel)!;
  const outputFormat = (input.outputFormat ?? 'mp3_44100_128').trim();

  const url = `${provider.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify({ text, model_id: modelId }),
  });

  if (!res.ok) {
    let err: unknown;
    try { err = await res.json(); } catch { /* ignore */ }
    return { ok: false, providerId: provider.id, operation: 'tts.synthesize', error: 'api_error', raw: err };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    ok: true,
    providerId: provider.id,
    operation: 'tts.synthesize',
    voiceId,
    model: modelId,
    audioBuffer: buffer,
    contentType: res.headers.get('content-type') ?? 'audio/mpeg',
  };
}

async function executeOpenAITts(
  provider: MediaProviderDefinition,
  input: MediaOperationInput,
  apiKey: string,
): Promise<MediaOperationResult> {
  const text = (input.text ?? '').trim();
  if (!text) return { ok: false, providerId: provider.id, operation: 'tts.synthesize', error: 'text_required' };

  const voice = (input.voiceId ?? 'alloy').trim();
  const model = (input.model ?? provider.defaultModel)!;
  const fmt = (input.audioFormat ?? 'mp3').trim();

  const res = await fetch(`${provider.baseUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: text, voice, response_format: fmt }),
  });

  if (!res.ok) return { ok: false, providerId: provider.id, operation: 'tts.synthesize', error: `api_error:${res.status}` };

  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    ok: true, providerId: provider.id, operation: 'tts.synthesize',
    voiceId: voice, model, audioBuffer: buffer,
    contentType: inferAudioMime(fmt),
  };
}

async function executeMiniMaxImage(
  provider: MediaProviderDefinition,
  input: MediaOperationInput,
  apiKey: string,
): Promise<MediaOperationResult> {
  const prompt = (input.prompt ?? '').trim();
  if (!prompt) return { ok: false, providerId: provider.id, operation: 'image.generate', error: 'prompt_required' };

  const model = (input.model ?? provider.defaultModel)!;
  const responseFormat = (input.responseFormat ?? 'url').trim();
  const n = input.n ?? 1;

  const body: Record<string, unknown> = { model, prompt, response_format: responseFormat, n };
  if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;

  const res = await fetch(`${provider.baseUrl}/v1/image_generation`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = await res.json() as Record<string, unknown>;
  if (!res.ok || (payload?.base_resp as any)?.status_code !== 0) {
    return { ok: false, providerId: provider.id, operation: 'image.generate', error: 'api_error', raw: payload };
  }

  const data = payload?.data as Record<string, unknown> | undefined;
  return {
    ok: true,
    providerId: provider.id,
    operation: 'image.generate',
    model,
    generationId: (payload?.id as string) ?? undefined,
    imageBase64: (data?.image_base64 as string[]) ?? [],
    imageUrls: (data?.image_urls as string[]) ?? [],
    raw: payload,
  };
}

async function executeOpenAIImage(
  provider: MediaProviderDefinition,
  input: MediaOperationInput,
  apiKey: string,
): Promise<MediaOperationResult> {
  const prompt = (input.prompt ?? '').trim();
  if (!prompt) return { ok: false, providerId: provider.id, operation: 'image.generate', error: 'prompt_required' };

  const model = (input.model ?? provider.defaultModel)!;
  const n = input.n ?? 1;
  const size = input.aspectRatio === '16:9' ? '1792x1024' : input.aspectRatio === '9:16' ? '1024x1792' : '1024x1024';

  const res = await fetch(`${provider.baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, n, size, response_format: 'url' }),
  });

  const payload = await res.json() as Record<string, unknown>;
  if (!res.ok) return { ok: false, providerId: provider.id, operation: 'image.generate', error: 'api_error', raw: payload };

  const images = (payload?.data as Array<{ url?: string }>) ?? [];
  return {
    ok: true, providerId: provider.id, operation: 'image.generate', model,
    imageUrls: images.map(i => i.url ?? '').filter(Boolean),
    raw: payload,
  };
}

async function executeMiniMaxVideo(
  provider: MediaProviderDefinition,
  input: MediaOperationInput,
  apiKey: string,
): Promise<MediaOperationResult> {
  const prompt = (input.prompt ?? '').trim();
  if (!prompt) return { ok: false, providerId: provider.id, operation: 'video.generate', error: 'prompt_required' };

  const endpointUrl = process.env.MINIMAX_VIDEO_GENERATE_URL;
  if (!endpointUrl) return { ok: false, providerId: provider.id, operation: 'video.generate', error: 'endpoint_not_configured' };

  const model = (input.model ?? provider.defaultModel)!;
  const responseFormat = (input.responseFormat ?? 'url').trim();

  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, response_format: responseFormat }),
  });

  const payload = await res.json() as Record<string, unknown>;
  if (!res.ok) return { ok: false, providerId: provider.id, operation: 'video.generate', error: 'api_error', raw: payload };

  const data = payload?.data as Record<string, unknown> | undefined;
  const urls = [
    data?.video_urls, data?.video_url, data?.file_urls,
    data?.file_url, data?.output_urls, data?.output_url,
  ].flat().filter((s): s is string => typeof s === 'string');

  return {
    ok: true, providerId: provider.id, operation: 'video.generate', model,
    videoUrls: urls,
    videoFormat: (data?.video_format as string) ?? 'mp4',
    generationId: ((payload?.id ?? payload?.task_id) as string) ?? undefined,
    raw: payload,
  };
}

// ── Persist helpers ───────────────────────────────────────────────

async function persistTts(result: MediaOperationResult, baseDir: string): Promise<MediaPersistResult> {
  const ts = Date.now();
  let buffer = result.audioBuffer;
  if (!buffer && result.audioHex) {
    buffer = Buffer.from(result.audioHex, 'hex');
  }
  if (buffer) {
    const ext = extForAudio(result.audioFormat);
    const filePath = resolve(baseDir, `${ts}-${sanitize(result.providerId)}${ext}`);
    await writeFile(filePath, buffer);
    return {
      path: filePath, bytes: buffer.byteLength,
      contentType: result.contentType ?? 'audio/mpeg',
      providerId: result.providerId, operation: result.operation,
    };
  }

  // Download from URL
  if (result.audioUrl) {
    try {
      const dl = await fetch(result.audioUrl);
      const buf = Buffer.from(await dl.arrayBuffer());
      const ext = extForAudio(result.audioFormat);
      const filePath = resolve(baseDir, `${ts}-${sanitize(result.providerId)}${ext}`);
      await writeFile(filePath, buf);
      return {
        path: filePath, bytes: buf.byteLength,
        contentType: result.contentType ?? 'audio/mpeg',
        providerId: result.providerId, operation: result.operation,
        sourceUrl: result.audioUrl,
      };
    } catch {
      // Fall through to manifest
    }
  }

  throw new Error('media_audio_buffer_missing');
}

async function persistImage(result: MediaOperationResult, baseDir: string): Promise<MediaPersistResult> {
  const ts = Date.now();
  const paths: string[] = [];

  // Base64 images
  const base64 = result.imageBase64?.filter(Boolean) ?? [];
  for (let i = 0; i < base64.length; i++) {
    try {
      const buf = decodeBase64(base64[i]);
      if (!buf) continue;
      const mimeMatch = base64[i].match(/^data:([^;]+);base64,/);
      const ext = mimeMatch ? extForImage(mimeMatch[1]) : '.png';
      const fp = resolve(baseDir, `${ts}-${sanitize(result.providerId)}-${i + 1}${ext}`);
      await writeFile(fp, buf);
      paths.push(fp);
    } catch { /* skip bad base64 */ }
  }

  // URL images
  const urls = result.imageUrls?.filter(Boolean) ?? [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const dl = await fetch(urls[i]);
      const buf = Buffer.from(await dl.arrayBuffer());
      const ext = extForImage(dl.headers.get('content-type') ?? '');
      const fp = resolve(baseDir, `${ts}-${sanitize(result.providerId)}-${base64.length + i + 1}${ext}`);
      await writeFile(fp, buf);
      paths.push(fp);
    } catch { /* skip bad url */ }
  }

  if (paths.length === 0) throw new Error('media_image_result_missing');

  return {
    path: paths[0], paths, count: paths.length,
    bytes: 0, // TODO: sum file sizes
    contentType: 'image/png',
    providerId: result.providerId, operation: result.operation,
    generationId: result.generationId,
  };
}

async function persistVideo(result: MediaOperationResult, baseDir: string): Promise<MediaPersistResult> {
  const ts = Date.now();
  const paths: string[] = [];

  const urls = result.videoUrls?.filter(Boolean) ?? [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const dl = await fetch(urls[i]);
      const buf = Buffer.from(await dl.arrayBuffer());
      const ext = extForVideo(result.videoFormat);
      const fp = resolve(baseDir, `${ts}-${sanitize(result.providerId)}-${i + 1}${ext}`);
      await writeFile(fp, buf);
      paths.push(fp);
    } catch { /* skip */ }
  }

  if (paths.length === 0) throw new Error('media_video_result_missing');

  return {
    path: paths[0], paths, count: paths.length,
    bytes: 0,
    contentType: inferVideoMime(result.videoFormat),
    providerId: result.providerId, operation: result.operation,
    generationId: result.generationId,
  };
}

// ── Utilities ─────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function decodeBase64(s: string): Buffer | null {
  const match = s.match(/^data:[^;]+;base64,(.+)$/);
  try {
    return Buffer.from(match ? match[1] : s, 'base64');
  } catch {
    return null;
  }
}

function extForAudio(format?: string): string {
  const f = (format ?? '').toLowerCase().trim();
  if (f.startsWith('mp3')) return '.mp3';
  if (f.startsWith('wav')) return '.wav';
  if (f.startsWith('flac')) return '.flac';
  if (f.startsWith('pcm')) return '.pcm';
  if (f.startsWith('opus') || f.startsWith('ogg')) return '.opus';
  return '.mp3';
}

function extForImage(mime?: string): string {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  return '.png';
}

function extForVideo(format?: string): string {
  const f = (format ?? '').toLowerCase().trim();
  if (f.includes('mp4')) return '.mp4';
  if (f.includes('mov') || f.includes('quicktime')) return '.mov';
  if (f.includes('webm')) return '.webm';
  return '.mp4';
}
