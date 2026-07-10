import type {
  NormalizerInput,
  OperatorPrincipal,
  RouteResult,
  RouteOptions,
} from '@los/agent/message-router';
import type { UnifiedMessage } from './channel/types.js';
import { authenticatedWxPusherIdentity } from './channel/wxpusher-ingress.js';

export type WxPusherRoute = (
  input: NormalizerInput,
  options: RouteOptions,
) => Promise<RouteResult>;

export async function routeTrustedWxPusherMessage(
  route: WxPusherRoute,
  message: UnifiedMessage,
): Promise<RouteResult> {
  const identity = authenticatedWxPusherIdentity(message);
  if (!identity) throw new Error('WxPusher message authentication is missing or inconsistent');

  const principal: OperatorPrincipal = {
    kind: 'operator',
    subject: `wxpusher:${identity.appId}:${identity.uid}`,
    authenticatedBy: 'trusted_channel',
    capabilities: ['operator:*'],
    userId: identity.uid,
  };
  const result = await route(
    {
      sourceKind: 'wx-weixin',
      text: message.text,
      uid: identity.uid,
      metadata: message.metadata as Record<string, unknown>,
    },
    { principal },
  );
  if (!result.handled || result.error) {
    throw new Error(`WxPusher route failed: ${result.error ?? 'not_handled'}`);
  }
  return result;
}
