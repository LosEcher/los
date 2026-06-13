import type { Message, ToolCall, ToolCallStatus } from './chat-messages.js';

function truncateJson(raw: string, maxLen: number): string {
  return raw.length > maxLen ? raw.slice(0, maxLen) + '…' : raw;
}

/** @deprecated Use trace projection (GET /sessions/:id/trace) as the single source of
 *  truth for message rendering. This function is retained for debug-mode raw event
 *  replay only. */
export function accumulateEvent(
  messages: Message[],
  event: string,
  data: Record<string, unknown>,
): Message[] {
  const msgs = [...messages];
  const last = msgs[msgs.length - 1];

  if (event === 'model.delta') {
    const textDelta = String(data.textDelta ?? data.text ?? data.delta ?? '');
    const reasoningDelta = String(data.reasoningDelta ?? '');
    const provider = typeof data.provider === 'string' ? data.provider : undefined;
    const model = typeof data.model === 'string' ? data.model : undefined;

    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        content: last.content + textDelta,
        reasoning: reasoningDelta ? (last.reasoning ?? '') + reasoningDelta : last.reasoning,
        provider: provider ?? last.provider,
        model: model ?? last.model,
      };
    } else {
      msgs.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: textDelta,
        reasoning: reasoningDelta || undefined,
        provider,
        model,
        toolCalls: [],
        turnIndex: (last?.turnIndex ?? 0) + 1,
      });
    }
    return msgs;
  }

  if (event === 'tool.call.upsert' || event === 'tool_call') {
    const toolName = String(data.toolName ?? data.tool ?? '');
    const callId = typeof data.callId === 'string' && data.callId ? data.callId : '';
    if (!callId) return msgs;
    const toolCall: ToolCall = {
      callId,
      toolName,
      argsPreview: typeof data.argsPreview === 'string' ? data.argsPreview : '',
      status: data.status === 'completed' || data.status === 'error' || data.status === 'denied' ? data.status : 'running',
      resultPreview: typeof data.resultPreview === 'string' ? data.resultPreview : undefined,
      errorPreview: typeof data.errorPreview === 'string' ? data.errorPreview : undefined,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
      attempts: typeof data.attempts === 'number' ? data.attempts : undefined,
    };
    const idx = [...msgs].reverse().findIndex(m => m.role === 'assistant' && m.toolCalls.some(tc => tc.callId === callId));
    if (idx >= 0) {
      const realIdx = msgs.length - 1 - idx;
      const target = msgs[realIdx]!;
      msgs[realIdx] = {
        ...target,
        toolCalls: target.toolCalls.map(tc => (tc.callId === callId ? { ...tc, ...toolCall } : tc)),
      };
      return msgs;
    }
    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        toolCalls: [...last.toolCalls, toolCall],
      };
    } else {
      msgs.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        toolCalls: [toolCall],
        turnIndex: (last?.turnIndex ?? 0) + 1,
      });
    }
    return msgs;
  }

  if (event === 'tool.call') {
    const toolName = typeof data.toolName === 'string' ? data.toolName : '';
    const payload = (data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload))
      ? (data.payload as Record<string, unknown>)
      : {};
    const callId = typeof payload.callId === 'string' ? payload.callId : '';
    if (!callId) return msgs;
    const args = (payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args))
      ? (payload.args as Record<string, unknown>)
      : undefined;
    let argsPreview = '';
    try {
      argsPreview = truncateJson(JSON.stringify(args ?? {}), 200);
    } catch {
      argsPreview = '';
    }
    const toolCall: ToolCall = {
      callId,
      toolName,
      args,
      argsPreview,
      status: 'running',
    };
    const idx = [...msgs].reverse().findIndex(m => m.role === 'assistant' && m.toolCalls.some(tc => tc.callId === callId));
    if (idx >= 0) {
      const realIdx = msgs.length - 1 - idx;
      const target = msgs[realIdx]!;
      msgs[realIdx] = {
        ...target,
        toolCalls: target.toolCalls.map(tc => (tc.callId === callId ? { ...tc, ...toolCall } : tc)),
      };
      return msgs;
    }

    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        toolCalls: [...last.toolCalls, toolCall],
      };
    } else {
      msgs.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        toolCalls: [toolCall],
        turnIndex: (last?.turnIndex ?? 0) + 1,
      });
    }
    return msgs;
  }

  if (event === 'tool.result') {
    const payload = (data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload))
      ? (data.payload as Record<string, unknown>)
      : {};
    const callId = typeof payload.callId === 'string' ? payload.callId : '';
    const ok = payload.ok === true;
    const denied = payload.denied === true;
    const status: ToolCallStatus = denied ? 'denied' : ok ? 'completed' : 'error';
    const resultPreview = typeof payload.contentPreview === 'string' ? payload.contentPreview : undefined;
    const errorPreview = typeof payload.errorPreview === 'string' ? payload.errorPreview : undefined;
    const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : undefined;
    const attempts = typeof payload.attempts === 'number' ? payload.attempts : undefined;

    const idx = [...msgs].reverse().findIndex(m => m.role === 'assistant' && m.toolCalls.some(tc => tc.callId === callId));
    if (idx >= 0) {
      const realIdx = msgs.length - 1 - idx;
      const target = msgs[realIdx]!;
      msgs[realIdx] = {
        ...target,
        toolCalls: target.toolCalls.map(tc => {
          if (tc.callId !== callId) return tc;
          return {
            ...tc,
            status,
            resultPreview: resultPreview ?? tc.resultPreview,
            errorPreview: errorPreview ?? tc.errorPreview,
            durationMs: durationMs ?? tc.durationMs,
            attempts: attempts ?? tc.attempts,
          };
        }),
      };
    }
    return msgs;
  }

  if (event === 'turn') {
    const toolNames: string[] = Array.isArray(data.toolNames) ? (data.toolNames as string[]) : [];
    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        content: last.content || String(data.text ?? ''),
        reasoning: String(data.reasoning ?? last.reasoning ?? ''),
        loopCount: Number(data.loopCount ?? 0),
        totalTurns: typeof data.totalTurns === 'number' ? data.totalTurns : last.totalTurns,
      };
    } else {
      msgs.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: String(data.text ?? ''),
        reasoning: String(data.reasoning ?? ''),
        toolCalls: toolNames.map(name => ({
          callId: crypto.randomUUID(),
          toolName: name,
          argsPreview: '',
          status: 'completed' as const,
        })),
        loopCount: Number(data.loopCount ?? 0),
        turnIndex: (last?.turnIndex ?? 0) + 1,
      });
    }
    return msgs;
  }

  if (event === 'done') {
    msgs.push({
      id: crypto.randomUUID(),
      role: 'system',
      content: typeof data.text === 'string' ? data.text : 'Run completed.',
      eventType: 'done',
      level: 'ok',
      meta: data.sessionId ? `session ${data.sessionId}` : undefined,
      toolCalls: [],
    });
    return msgs;
  }

  if (event === 'error') {
    msgs.push({
      id: crypto.randomUUID(),
      role: 'system',
      content: String(data.message ?? 'stream error'),
      eventType: 'error',
      level: 'error',
      toolCalls: [],
    });
    return msgs;
  }

  if (event === 'session' || event === 'session.resumed' || event === 'session.branched' ||
      event === 'session.resume_state' || event === 'session.loading') {
    msgs.push({
      id: crypto.randomUUID(),
      role: 'system',
      content: formatSessionEvent(event, data),
      eventType: event,
      level: 'ok',
      meta: eventMeta(event, data),
      toolCalls: [],
    });
    return msgs;
  }

  if (event === 'task') {
    const status = String(data.status ?? '');
    msgs.push({
      id: crypto.randomUUID(),
      role: 'system',
      content: String(data.type ?? data.status ?? 'task event'),
      eventType: 'task',
      level: status.includes('succeeded') ? 'ok' : status.includes('failed') ? 'error' : 'normal',
      meta: [data.taskRunId, data.nodeId].filter(Boolean).join(' · '),
      toolCalls: [],
    });
    return msgs;
  }

  if (event === 'cancelled' || event === 'deduplicated') {
    msgs.push({
      id: crypto.randomUUID(),
      role: 'system',
      content: event === 'cancelled' ? 'Run cancelled.' : 'Deduplicated — matching run already in progress.',
      eventType: event,
      level: 'warn',
      meta: data.taskRunId ? `task ${data.taskRunId}` : undefined,
      toolCalls: [],
    });
    return msgs;
  }

  msgs.push({
    id: crypto.randomUUID(),
    role: 'system',
    content: JSON.stringify(data),
    eventType: event,
    level: 'normal',
    meta: `event: ${event}`,
    toolCalls: [],
  });
  return msgs;
}

function formatSessionEvent(event: string, data: Record<string, unknown>): string {
  if (event === 'session' && data.sessionId) return `Session started: ${data.sessionId}`;
  if (event === 'session.resumed') return `Resumed session (${data.turnCount ?? '?'} turns, ${data.messageCount ?? '?'} msgs)`;
  if (event === 'session.branched') return `Branched from ${String(data.parentSessionId ?? 'unknown')}`;
  if (event === 'session.resume_state') return 'Loaded session resume state.';
  if (event === 'session.loading') return String(data.message ?? data);
  return String(data.message ?? data);
}

function eventMeta(event: string, data: Record<string, unknown>): string | undefined {
  if (event === 'session') return data.taskRunId ? `task ${data.taskRunId}` : undefined;
  if (event === 'session.branched') return `${data.copiedMessageCount ?? data.messageCount ?? '?'} messages copied`;
  if (event === 'session.resumed') return `last task ${String(data.resumeLastTaskRunId ?? 'none')}`;
  return undefined;
}
