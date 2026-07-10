import { recordOperatorSteering } from '@los/agent/operator-control';
import type { MessagePrincipal } from '@los/agent/message-router';

interface WsControlDependencies {
  principal: MessagePrincipal;
  sessionId: string;
  send: (event: string, data: unknown) => void;
  recordSteering?: typeof recordOperatorSteering;
}

export async function handleWsControlMessage(
  raw: { toString(): string },
  deps: WsControlDependencies,
): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw.toString()) as Record<string, unknown>;
  } catch {
    return;
  }

  if (msg.type === 'ping') {
    deps.send('pong', { ts: Date.now() });
    return;
  }
  if (msg.type !== 'steering' && msg.type !== 'cancel') return;

  const canSteer = deps.principal.kind === 'operator'
    && (deps.principal.capabilities.includes('operator:*')
      || deps.principal.capabilities.includes('session:steer'));
  if (!canSteer) {
    deps.send('error', { error: 'operator_required' });
    return;
  }

  const instruction = msg.type === 'cancel'
    ? 'deny'
    : typeof msg.instruction === 'string'
      ? msg.instruction
      : '';
  if (!instruction) {
    deps.send('error', { error: 'steering_instruction_required' });
    return;
  }
  const turnBoundary = msg.turnBoundary === 'next_turn' ? 'next_turn' : 'immediate';
  const reason = typeof msg.reason === 'string' ? msg.reason : `ws ${msg.type}`;
  try {
    const event = await (deps.recordSteering ?? recordOperatorSteering)({
      sessionId: deps.sessionId,
      instruction,
      turnBoundary,
      reason,
      actor: deps.principal.subject,
    });
    deps.send('steering.ack', {
      ok: true,
      type: msg.type,
      instruction,
      eventId: event.id,
      eventType: event.type,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send('error', { error: 'steering_failed', message });
  }
}
