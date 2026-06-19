/**
 * @los/agent/tools/web-tools — Web search and fetch tools.
 *
 * web_search: search the web via DuckDuckGo Lite, return ranked results.
 * web_fetch: download a URL and return plain text content.
 */

import { getLogger } from '@los/infra/logger';
import type { ToolRegistry } from '../core/registry.js';

const log = getLogger('agent');

// ── web_search ──────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function registerWebSearchTool(registry: ToolRegistry): void {
  registry.register('web_search', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const query = String(args.query ?? '').trim();
    if (!query) return { content: '', error: 'query is required' };
    const topK = clampTopK(Number(args.topK ?? 5));

    try {
      const results = await searchDuckDuckGo(query, topK);
      if (results.length === 0) {
        return { content: `No results found for: ${query}` };
      }

      const output = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
      ).join('\n\n');

      return { content: output };
    } catch (err: any) {
      log.warn(`web_search failed: ${err?.message ?? String(err)}`);
      return { content: '', error: `Search failed: ${err?.message ?? String(err)}` };
    }
  }, {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public web and return ranked results with title, URL, and snippet. ' +
        'Use this when the answer depends on current, real-world information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          topK: { type: 'number', description: 'Number of results (default 5).' },
        },
        required: ['query'],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['web:read'],
    timeoutMs: 30_000,
    retryable: true,
    idempotent: true,
    costLevel: 'low',
    sideEffect: false,
    tags: ['web', 'read'],
  });
}

async function searchDuckDuckGo(query: string, topK: number): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'los/0.1 (web-search)',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`DDG returned ${res.status}`);
  }

  const html = await res.text();
  return parseDDGLiteResults(html, topK);
}

function parseDDGLiteResults(html: string, topK: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DDG Lite format: each result is a <tr> with class "result-snippet"
  // containing <a> for title/url and <td> for snippet
  // Simpler approach: use regex to extract result rows

  // Match result rows: link in format <a rel="nofollow" href="URL">TITLE</a>
  // followed by snippet text
  const rowRegex = /<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  let match;
  while ((match = rowRegex.exec(html)) !== null && results.length < topK) {
    let url = match[1] ?? '';
    const title = decodeEntities(match[2] ?? '').trim();
    let snippet = decodeEntities(stripTags(match[3] ?? '')).trim();

    // Skip internal DDG links
    if (url.startsWith('//duckduckgo.com') || url.startsWith('/')) continue;
    if (!url.startsWith('http')) url = 'https:' + url;

    // Skip empty titles
    if (!title) continue;

    results.push({ title, url, snippet: snippet.slice(0, 300) });
  }

  return results;
}

// ── web_fetch ───────────────────────────────────────────

export function registerWebFetchTool(registry: ToolRegistry): void {
  registry.register('web_fetch', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const url = String(args.url ?? '').trim();
    if (!url) return { content: '', error: 'url is required' };

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { content: '', error: 'url must start with http:// or https://' };
    }

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'los/0.1 (web-fetch)',
          'Accept': 'text/html, text/plain, */*',
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
      });

      if (!res.ok) {
        return { content: '', error: `HTTP ${res.status} ${res.statusText}` };
      }

      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();

      if (contentType.includes('text/html')) {
        const plain = htmlToText(text);
        return { content: truncateText(plain, 8000) };
      }

      // Return as-is for plain text, JSON, etc.
      return { content: truncateText(text, 8000) };
    } catch (err: any) {
      log.warn(`web_fetch failed for ${url}: ${err?.message ?? String(err)}`);
      return { content: '', error: `Fetch failed: ${err?.message ?? String(err)}` };
    }
  }, {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Download a URL and return its visible text content. ' +
        'HTML pages get stripped of scripts, styles, and navigation. ' +
        'Truncated at 8000 characters.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http:// or https:// URL.' },
        },
        required: ['url'],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['web:read'],
    timeoutMs: 30_000,
    retryable: true,
    idempotent: true,
    costLevel: 'low',
    sideEffect: false,
    tags: ['web', 'read'],
  });
}

// ── HTML to Text ────────────────────────────────────────

function htmlToText(html: string): string {
  // Remove scripts, styles, and head sections
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    // Replace block elements with newlines
    .replace(/<\/(div|p|h[1-6]|li|tr|article|section|header|footer|main)[^>]*>/gi, '\n')
    .replace(/<br[^>]*\/?>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]*>/g, '')
    // Decode entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

  text = decodeEntities(text);

  // Collapse whitespace
  return text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n');
}

// ── Helpers ─────────────────────────────────────────────

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n... [truncated ${text.length - maxLength} chars]`;
}

function clampTopK(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 5;
  return Math.min(Math.floor(value), 10);
}

// ── Bulk Registration ───────────────────────────────────

export function registerWebTools(registry: ToolRegistry): void {
  registerWebSearchTool(registry);
  registerWebFetchTool(registry);
}
