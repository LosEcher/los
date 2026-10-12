/**
 * Client-supplied OpenAI tools skip the los agent loop.
 *
 * `/v1/chat/completions` normally flattens messages into `runChat`. That drops
 * `tools` and `tool_choice`, so a caller such as CanTool cannot receive a
 * tool call. When the client sends tools, this module forwards the completion
 * to the named provider and returns the provider body unchanged.
 */

import { getConfig } from '@los/infra/config';
import { listProviderDefaults } from '@los/infra/provider-defaults';

export class ToolForwardError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ToolForwardError';
  }
}

export interface ToolForwardTarget {
  url: string;
  apiKey: string;
  model: string;
}

export function clientSuppliedTools(body: { tools?: unknown }): unknown[] | null {
  if (!Array.isArray(body.tools)) return null;
  const tools = body.tools.filter(tool => tool !== null && typeof tool === 'object');
  return tools.length > 0 ? tools : null;
}

/** Same join as `@los/agent` `buildOpenAICompatUrl`. Kept here to avoid a new export. */
export function openAICompatChatUrl(baseUrl: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  if (cleanBase.endsWith('/v1')) return `${cleanBase}/chat/completions`;
  return `${cleanBase}/v1/chat/completions`;
}

/**
 * 解析工具转发的上游目标。
 *
 * 入参可以是 **provider 名**（OpenAI 兼容面的既有约定：`/v1/models` 列的就是 provider 名），
 * 也可以是**模型 id**（2026-10-11 新增）。
 *
 * 为什么需要"模型 id"这一支：远端执行器把自己的 provider 指向本网关后，它发上来的是
 * **模型名**（节点的 provider 是"厂商 + 默认模型"，`modelProfile.model` 是 `deepseek-flash`），
 * 而不是 provider 名。只认 provider 名 ⇒ 节点侧必须把模型名改成 provider 名，那会让节点的
 * 模型档位/能力画像跟着变（等于为了走代理而改语义）。这一支把"认得模型 id"这件事放在网关侧，
 * 节点配置保持与直连时**逐字相同**，只换 baseUrl。
 *
 * 匹配规则（确定性，不猜）：`provider.model` 显式相等，或 `provider-defaults` 里该 provider 的
 * `defaultModel` 相等；多个 provider 命中时按名字排序取第一个，**并把歧义写进错误信息之外**——
 * 目前调用方只有"一个模型名对一个 provider"的场景。
 */
export function resolveToolForwardTarget(providerNameOrModel: string): ToolForwardTarget {
  const config = getConfig();
  const direct = config.providers[providerNameOrModel];
  if (direct && direct.enabled !== false) {
    return buildTarget(providerNameOrModel, direct, direct.model?.trim() || providerNameOrModel);
  }
  const byModel = findProviderByModel(providerNameOrModel);
  if (byModel) {
    // 按模型 id 命中时，**原样转发请求里的模型名**（节点要什么就给它什么）。
    return buildTarget(byModel.name, byModel.provider, providerNameOrModel);
  }
  throw new ToolForwardError(400, `Provider '${providerNameOrModel}' is not configured.`);
}

function buildTarget(
  name: string,
  provider: { baseUrl?: string; apiKey?: string },
  model: string,
): ToolForwardTarget {
  if (!provider.baseUrl || !provider.apiKey) {
    throw new ToolForwardError(
      400,
      `Provider '${name}' has no API credential for client tool forwarding.`,
    );
  }
  return {
    url: openAICompatChatUrl(provider.baseUrl),
    apiKey: provider.apiKey,
    model,
  };
}

function findProviderByModel(model: string): { name: string; provider: NonNullable<ReturnType<typeof getConfig>['providers'][string]> } | undefined {
  const providers = getConfig().providers ?? {};
  const defaults = new Map(listProviderDefaults().map(item => [item.name as string, item.defaults.defaultModel]));
  const matches = Object.entries(providers)
    .filter(([, provider]) => provider && provider.enabled !== false)
    .filter(([name, provider]) =>
      provider.model?.trim() === model || defaults.get(name) === model)
    .sort(([a], [b]) => a.localeCompare(b));
  const first = matches[0];
  return first ? { name: first[0], provider: first[1]! } : undefined;
}

export function buildToolForwardBody(input: {
  model: string;
  messages: unknown;
  tools: unknown[];
  toolChoice: unknown;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    tools: input.tools,
    tool_choice: input.toolChoice === undefined ? 'auto' : input.toolChoice,
    stream: input.stream,
  };
  if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
  if (input.temperature !== undefined) body.temperature = input.temperature;
  return body;
}

export function safeUpstreamMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Upstream provider rejected the tool completion.';
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string' && parsed.error.message.trim()) {
      return parsed.error.message.trim().slice(0, 500);
    }
  } catch {
    // Not JSON. Fall through to a clipped body with credentials removed.
  }
  return trimmed.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
}

export interface ForwardClientToolsInput {
  reply: {
    status: (code: number) => { send: (body: unknown) => unknown };
    send: (body: unknown) => unknown;
    raw: {
      writeHead: (code: number, headers: Record<string, string>) => void;
      write: (chunk: Uint8Array | string) => void;
      end: () => void;
      on: (event: string, listener: () => void) => void;
      writableEnded?: boolean;
    };
  };
  providerName: string;
  request: {
    messages?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
    max_tokens?: number;
    temperature?: number;
  };
  stream: boolean;
  resolveTarget?: (providerName: string) => ToolForwardTarget;
  fetchImpl?: typeof fetch;
}

export async function forwardClientToolCompletion(input: ForwardClientToolsInput): Promise<void> {
  const tools = clientSuppliedTools(input.request);
  if (!tools) {
    throw new ToolForwardError(400, 'Client tool forwarding requires a non-empty tools array.');
  }
  if (!Array.isArray(input.request.messages) || input.request.messages.length === 0) {
    throw new ToolForwardError(400, 'Client tool forwarding requires messages.');
  }

  let target: ToolForwardTarget;
  try {
    target = (input.resolveTarget ?? resolveToolForwardTarget)(input.providerName);
  } catch (error) {
    const statusCode = error instanceof ToolForwardError ? error.statusCode : 400;
    const message = error instanceof Error ? error.message : 'Provider is not available.';
    input.reply.status(statusCode).send({
      error: { message, type: 'invalid_request_error', code: 'tool_forward_unavailable' },
    });
    return;
  }

  const outbound = buildToolForwardBody({
    model: target.model,
    messages: input.request.messages,
    tools,
    toolChoice: input.request.tool_choice,
    stream: input.stream,
    maxTokens: input.request.max_tokens,
    temperature: input.request.temperature,
  });
  const fetchImpl = input.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetchImpl(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify(outbound),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upstream provider request failed.';
    input.reply.status(502).send({
      error: { message: safeUpstreamMessage(message), type: 'upstream_error', code: 'tool_forward_network' },
    });
    return;
  }

  if (!upstream.ok) {
    const raw = await upstream.text();
    input.reply.status(upstream.status).send({
      error: { message: safeUpstreamMessage(raw), type: 'upstream_error', code: 'tool_forward_rejected' },
    });
    return;
  }

  if (input.stream) {
    input.reply.raw.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const reader = upstream.body?.getReader();
    if (!reader) {
      input.reply.raw.end();
      return;
    }
    let closed = false;
    input.reply.raw.on('close', () => {
      closed = true;
    });
    try {
      while (!closed) {
        const next = await reader.read();
        if (next.done) break;
        input.reply.raw.write(next.value);
      }
    } finally {
      input.reply.raw.end();
    }
    return;
  }

  input.reply.send(await upstream.json());
}
