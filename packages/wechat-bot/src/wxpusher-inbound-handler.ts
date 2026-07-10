import type { MessageRouter } from '@los/agent/message-router';
import { getLogger, type Logger } from '@los/infra/logger';
import type { UnifiedMessage } from './channel/types.js';
import { routeTrustedWxPusherMessage } from './wxpusher-routing.js';

export function createWxPusherInboundHandler(
  router: Pick<MessageRouter, 'route'>,
  logger: Pick<Logger, 'error'> = getLogger('wxpusher-inbound-handler'),
): (message: UnifiedMessage) => Promise<void> {
  return async (message) => {
    try {
      await routeTrustedWxPusherMessage(router.route.bind(router), message);
    } catch (error) {
      logger.error('WxPusher inbound routing failed', {
        errorClass: error instanceof Error ? error.constructor.name : 'UnknownError',
      });
      throw error;
    }
  };
}
