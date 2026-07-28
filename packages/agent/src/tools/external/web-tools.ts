/**
 * @los/agent/tools/web-tools — Web search and HTTP request tools.
 *
 * web_search: search the web via DuckDuckGo Lite, return ranked results.
 * web_fetch:   download a URL (GET) and return plain text content.
 * http_request: full HTTP client — GET/POST/PUT/DELETE/PATCH with custom headers and body.
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
// Lightweight GET-only with HTML→text conversion, kept for simple use cases.

export function registerWebFetchTool(registry: ToolRegistry): void {
  registry.register('web_fetch', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const url = String(args.url ?? '').trim();
    if (!url) return { content: '', error: 'url is required' };

    if (!isSafeUrl(url)) {
      return { content: '', error: 'url targets a private/internal address' };
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
        'Truncated at 8000 characters. For POST/PUT/DELETE with custom headers, use http_request.',
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

// ── http_request ────────────────────────────────────────
// Full HTTP client with method, headers, and body support.

export function registerHttpRequestTool(registry: ToolRegistry): void {
  const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

  registry.register('http_request', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const url = String(args.url ?? '').trim();
    if (!url) return { content: '', error: 'url is required' };

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { content: '', error: 'url must start with http:// or https://' };
    }

    if (!isSafeUrl(url)) {
      return { content: '', error: 'url targets a private/internal address (localhost, 10.x, 172.16-31.x, 192.168.x are blocked)' };
    }

    const method = String(args.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
      return { content: '', error: `method ${method} not allowed. Use: ${ALLOWED_METHODS.join(', ')}` };
    }

    const maxChars = clampMaxChars(Number(args.maxChars ?? 8000));
    const timeout = Math.min(Number(args.timeout ?? 30000), 60000);

    // Parse headers
    const customHeaders: Record<string, string> = {};
    const rawHeaders = args.headers as Record<string, unknown> | undefined;
    if (rawHeaders && typeof rawHeaders === 'object') {
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (typeof value === 'string' && value.length <= 4096) {
          // Block dangerous header overrides
          const lowerKey = key.toLowerCase();
          if (lowerKey === 'host' || lowerKey === 'origin' || lowerKey === 'referer') continue;
          customHeaders[key] = value;
        }
      }
    }

    // Parse body
    let body: string | undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const rawBody = args.body;
      if (rawBody !== undefined && rawBody !== null) {
        body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
        if (body.length > 64_000) {
          return { content: '', error: 'body exceeds 64KB limit' };
        }
      }
    }

    try {
      const fetchHeaders: Record<string, string> = {
        'User-Agent': 'los/0.1 (http-request)',
        'Accept': 'text/html, text/plain, application/json, */*',
        ...customHeaders,
      };

      const res = await fetch(url, {
        method,
        headers: fetchHeaders,
        body,
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });

      const contentType = res.headers.get('content-type') ?? '';
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (k.length < 50 && v.length < 1000) responseHeaders[k] = v;
      });

      const rawText = await res.text();
      let displayText = rawText;

      if (contentType.includes('text/html')) {
        displayText = htmlToText(rawText);
      } else if (contentType.includes('application/json')) {
        try {
          displayText = JSON.stringify(JSON.parse(rawText), null, 2);
        } catch { /* keep raw */ }
      }

      const truncated = truncateText(displayText, maxChars);
      let content = `HTTP ${res.status} ${res.statusText}\n`;
      content += `Content-Type: ${contentType}\n`;
      if (Object.keys(responseHeaders).length > 0) {
        content += `\nResponse Headers:\n${JSON.stringify(responseHeaders, null, 2)}\n`;
      }
      content += `\n${truncated}`;

      return { content };
    } catch (err: any) {
      log.warn(`http_request failed for ${url}: ${err?.message ?? String(err)}`);
      return { content: '', error: `Request failed: ${err?.message ?? String(err)}` };
    }
  }, {
    type: 'function',
    function: {
      name: 'http_request',
      description:
        'Make an HTTP request to a URL. Supports GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS. ' +
        'Set custom headers (as a JSON object) and a request body for POST/PUT/PATCH. ' +
        'Returns status, response headers, and body (HTML is converted to text, JSON is pretty-printed). ' +
        'Private/internal IPs (localhost, 10.x, 172.16-31.x, 192.168.x) are blocked for security.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http:// or https:// URL.' },
          method: {
            type: 'string',
            description: 'HTTP method. Default: GET. Allowed: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS.',
          },
          headers: {
            type: 'object',
            description: 'Custom request headers as a JSON object. Example: {"Content-Type": "application/json", "Authorization": "Bearer token"}',
          },
          body: {
            description: 'Request body (string or JSON object). Only for POST, PUT, PATCH. Max 64KB.',
          },
          maxChars: {
            type: 'number',
            description: 'Max characters in the response body. Default 8000, max 32000.',
          },
          timeout: {
            type: 'number',
            description: 'Request timeout in milliseconds. Default 30000, max 60000.',
          },
        },
        required: ['url'],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['web:read', 'web:write'],
    timeoutMs: 60_000,
    retryable: true,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['web', 'http', 'api'],
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
  registerHttpRequestTool(registry);
}

// ── SSRF Protection ────────────────────────────────────
// Block requests to private/internal IP ranges and localhost.

const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost[:\/]/i,
  /^https?:\/\/127\.\d{1,3}\.\d{1,3}\.\d{1,3}[:\/]/,
  /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}[:\/]/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}[:\/]/,
  /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}[:\/]/,
  /^https?:\/\/0\.0\.0\.0[:\/]/,
  /^https?:\/\/\[::1\][:\/]/,
  /^https?:\/\/169\.254\.\d{1,3}\.\d{1,3}[:\/]/,
];

function isSafeUrl(url: string): boolean {
  return !PRIVATE_IP_PATTERNS.some(pattern => pattern.test(url));
}

function clampMaxChars(value: number): number {
  if (!Number.isFinite(value) || value < 100) return 8000;
  return Math.min(Math.floor(value), 32000);
}
