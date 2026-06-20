/**
 * @los/media/provider-catalog — Media provider definitions and catalog.
 *
 * Defines available TTS, ASR, image generation, and video generation
 * providers. Each provider declares its operations, execution mode,
 * and API configuration.
 *
 * Provider configuration is loaded from environment variables at runtime.
 * Inspired by lsclaw's media-runtime.mjs PROVIDER_DEFINITIONS.
 */

// ── Types ─────────────────────────────────────────────────────────

export type MediaKind = 'tts' | 'asr' | 'image' | 'video';

export type MediaOperation =
  | 'tts.synthesize'
  | 'asr.transcribe'
  | 'image.generate'
  | 'video.generate';

export interface MediaProviderDefinition {
  id: string;
  kind: MediaKind;
  label: string;
  execution: 'remote_http' | 'local_cli';
  operations: MediaOperation[];
  /** Environment variable name for the API key */
  apiKeyEnv?: string;
  /** Default base URL */
  baseUrl?: string;
  /** Default model */
  defaultModel?: string;
}

export interface MediaProviderCatalog {
  tts: MediaProviderDefinition[];
  asr: MediaProviderDefinition[];
  image: MediaProviderDefinition[];
  video: MediaProviderDefinition[];
}

// ── Provider definitions ──────────────────────────────────────────

const PROVIDERS: MediaProviderDefinition[] = [
  // ── TTS ──────────────────────────────────────────────
  {
    id: 'minimax-tts',
    kind: 'tts',
    label: 'MiniMax TTS',
    execution: 'remote_http',
    operations: ['tts.synthesize'],
    apiKeyEnv: 'MINIMAX_MEDIA_API_KEY',
    baseUrl: 'https://api.minimaxi.com',
    defaultModel: 'speech-2.8-hd',
  },
  {
    id: 'elevenlabs-tts',
    kind: 'tts',
    label: 'ElevenLabs TTS',
    execution: 'remote_http',
    operations: ['tts.synthesize'],
    apiKeyEnv: 'ELEVENLABS_API_KEY',
    baseUrl: 'https://api.elevenlabs.io',
    defaultModel: 'eleven_multilingual_v2',
  },
  {
    id: 'openai-tts',
    kind: 'tts',
    label: 'OpenAI TTS',
    execution: 'remote_http',
    operations: ['tts.synthesize'],
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com',
    defaultModel: 'tts-1',
  },

  // ── ASR ──────────────────────────────────────────────
  {
    id: 'minimax-asr',
    kind: 'asr',
    label: 'MiniMax ASR',
    execution: 'remote_http',
    operations: ['asr.transcribe'],
    apiKeyEnv: 'MINIMAX_MEDIA_API_KEY',
    baseUrl: 'https://api.minimaxi.com',
  },

  // ── Image ────────────────────────────────────────────
  {
    id: 'minimax-image',
    kind: 'image',
    label: 'MiniMax Image',
    execution: 'remote_http',
    operations: ['image.generate'],
    apiKeyEnv: 'MINIMAX_MEDIA_API_KEY',
    baseUrl: 'https://api.minimaxi.com',
    defaultModel: 'image-01',
  },
  {
    id: 'openai-image',
    kind: 'image',
    label: 'OpenAI DALL-E',
    execution: 'remote_http',
    operations: ['image.generate'],
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com',
    defaultModel: 'dall-e-3',
  },

  // ── Video ────────────────────────────────────────────
  {
    id: 'minimax-video',
    kind: 'video',
    label: 'MiniMax Video',
    execution: 'remote_http',
    operations: ['video.generate'],
    apiKeyEnv: 'MINIMAX_MEDIA_API_KEY',
    defaultModel: 'video-01',
  },
];

// ── Catalog helpers ────────────────────────────────────────────────

function trim(s: unknown): string {
  return typeof s === 'string' ? s.trim() : '';
}

export function getProviderCatalog(): MediaProviderCatalog {
  const grouped: MediaProviderCatalog = { tts: [], asr: [], image: [], video: [] };
  for (const p of PROVIDERS) {
    grouped[p.kind].push(p);
  }
  return grouped;
}

export function getProviderCatalogFlat(): MediaProviderDefinition[] {
  return PROVIDERS;
}

export function getProviderDefinition(providerId: string): MediaProviderDefinition | null {
  return PROVIDERS.find(p => p.id === trim(providerId)) ?? null;
}

export function resolveApiKey(provider: MediaProviderDefinition, env: Record<string, string | undefined> = process.env): string {
  if (!provider.apiKeyEnv) return '';

  // Check the primary env var
  const primary = trim(env[provider.apiKeyEnv] ?? process.env[provider.apiKeyEnv]);
  if (primary) return primary;

  // Fallback: MINIMAX_MEDIA_API_KEY → MINIMAX_API_KEY
  if (provider.apiKeyEnv === 'MINIMAX_MEDIA_API_KEY') {
    const fallback = trim(env['MINIMAX_API_KEY'] ?? process.env['MINIMAX_API_KEY']);
    if (fallback) return fallback;
  }

  // Fallback: OPENAI_API_KEY for all OpenAI providers
  if (provider.id.startsWith('openai-')) {
    return trim(env['OPENAI_API_KEY'] ?? process.env['OPENAI_API_KEY']);
  }

  return '';
}

export function listAvailableProviders(env: Record<string, string | undefined> = process.env): MediaProviderDefinition[] {
  return PROVIDERS.filter(p => resolveApiKey(p, env) !== '');
}

export function inferMediaKind(operation: MediaOperation): MediaKind {
  if (operation.startsWith('tts.')) return 'tts';
  if (operation.startsWith('asr.')) return 'asr';
  if (operation.startsWith('image.')) return 'image';
  if (operation.startsWith('video.')) return 'video';
  return 'tts';
}

// MIME type helpers
export function inferAudioMime(format?: string, fallback = 'audio/mpeg'): string {
  const f = (format ?? '').toLowerCase().trim();
  if (f === 'wav') return 'audio/wav';
  if (f === 'flac') return 'audio/flac';
  if (f === 'pcm') return 'audio/pcm';
  if (f === 'mp3') return 'audio/mpeg';
  if (f === 'opus') return 'audio/opus';
  if (f === 'ogg') return 'audio/ogg';
  return fallback;
}

export function inferImageMime(format?: string, fallback = 'image/png'): string {
  const f = (format ?? '').toLowerCase().trim();
  if (f.includes('png')) return 'image/png';
  if (f.includes('jpeg') || f.includes('jpg')) return 'image/jpeg';
  if (f.includes('webp')) return 'image/webp';
  if (f.includes('gif')) return 'image/gif';
  return fallback;
}

export function inferVideoMime(format?: string, fallback = 'video/mp4'): string {
  const f = (format ?? '').toLowerCase().trim();
  if (f.includes('mp4')) return 'video/mp4';
  if (f.includes('quicktime') || f.includes('mov')) return 'video/quicktime';
  if (f.includes('webm')) return 'video/webm';
  return fallback;
}
