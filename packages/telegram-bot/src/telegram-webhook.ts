import type { RequestListener, Server } from 'node:http';
import {
  readJsonBody,
  RequestBodyTooLargeError,
  webhookSecretMatches,
} from './ingress-security.js';
import type { TelegramUpdate } from './operator-actions.js';

interface TelegramWebhookHandlerOptions {
  secret: string;
  processUpdate: (update: TelegramUpdate) => Promise<unknown>;
}

interface StartTelegramWebhookOptions {
  server: Server;
  port: number;
  host: string;
  webhookUrl: string;
  secret: string;
  setWebhook: (body: Record<string, unknown>) => Promise<unknown>;
}

export function createTelegramWebhookHandler(options: TelegramWebhookHandlerOptions): RequestListener {
  return async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/telegram-webhook') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!webhookSecretMatches(request.headers['x-telegram-bot-api-secret-token'], options.secret)) {
      response.writeHead(401);
      response.end('unauthorized');
      return;
    }

    try {
      const update = await readJsonBody(request) as TelegramUpdate;
      await options.processUpdate(update);
      response.writeHead(200);
      response.end('ok');
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413
        : error instanceof SyntaxError || isInvalidUpdate(error) ? 400
        : 500;
      response.writeHead(status);
      response.end(status === 413 ? 'payload too large' : status === 400 ? 'invalid request' : 'processing failed');
    }
  };
}

export async function startTelegramWebhook(options: StartTelegramWebhookOptions): Promise<void> {
  try {
    await listen(options.server, options.port, options.host);
    const result = await options.setWebhook({
      url: `${options.webhookUrl}/telegram-webhook`,
      secret_token: options.secret,
      allowed_updates: ['message', 'callback_query'],
    });
    if (!isSuccessfulWebhookRegistration(result)) {
      const description = getWebhookRegistrationDescription(result);
      throw new Error(description ? `Telegram setWebhook rejected: ${description}` : 'Telegram setWebhook rejected');
    }
  } catch (error) {
    await close(options.server);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Telegram webhook startup failed: ${message}`, { cause: error });
  }
}

function isInvalidUpdate(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith('Telegram update_id') || error.message.startsWith('Telegram callback_query.id')
  );
}

function isSuccessfulWebhookRegistration(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const response = result as Record<string, unknown>;
  return response.ok === true && response.result === true;
}

function getWebhookRegistrationDescription(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const description = (result as Record<string, unknown>).description;
  return typeof description === 'string' && description.length > 0 ? description : undefined;
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
