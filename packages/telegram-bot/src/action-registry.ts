import { randomBytes } from 'node:crypto';
import {
  claimTelegramAction,
  consumeTelegramAction,
  insertTelegramActionEntries,
  releaseTelegramAction,
  type TelegramActionClaim,
  type TelegramActionEntry,
} from './telegram-action-store.js';

export type TelegramOperatorAction = 'approve' | 'deny' | 'escalate';

export interface TelegramActionTarget {
  action: TelegramOperatorAction;
  sessionId: string;
  callId: string;
}

export type TelegramButtonRows = Array<Array<{ text: string; callback_data: string }>>;

export class TelegramActionRegistry {
  constructor(
    private readonly ttlMs = 7 * 24 * 60 * 60 * 1000,
    private readonly createToken = () => randomBytes(16).toString('base64url'),
    private readonly now = () => Date.now(),
    private readonly claimLeaseMs = 60_000,
  ) {}

  createDecisionGroupId(): string {
    return `tgd:${randomBytes(16).toString('base64url')}`;
  }

  async createButtons(
    sessionId: string,
    callId: string,
    decisionGroupId = this.createDecisionGroupId(),
  ): Promise<TelegramButtonRows> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const expiresAt = new Date(this.now() + this.ttlMs);
      const entries: TelegramActionEntry[] = [
        this.createEntry('approve', sessionId, callId, decisionGroupId, expiresAt),
        this.createEntry('deny', sessionId, callId, decisionGroupId, expiresAt),
        this.createEntry('escalate', sessionId, callId, decisionGroupId, expiresAt),
      ];
      if (await insertTelegramActionEntries(entries)) {
        return [
          [
            { text: '✅ Approve', callback_data: entries[0]!.token },
            { text: '❌ Deny', callback_data: entries[1]!.token },
          ],
          [{ text: '↗ Escalate', callback_data: entries[2]!.token }],
        ];
      }
    }
    throw new Error('Unable to persist unique Telegram action tokens');
  }

  async claim(callbackData: string, claimId: string): Promise<TelegramActionClaim> {
    if (!isValidCallbackData(callbackData)) return { status: 'invalid' };
    const now = new Date(this.now());
    return claimTelegramAction(
      callbackData,
      claimId,
      now,
      new Date(now.getTime() + this.claimLeaseMs),
    );
  }

  async consume(callbackData: string, claimId: string, callbackId: string, userId: number): Promise<void> {
    const consumed = await consumeTelegramAction(
      callbackData,
      claimId,
      callbackId,
      userId,
      new Date(this.now()),
    );
    if (!consumed) throw new Error('Telegram action claim was lost before consume');
  }

  async release(callbackData: string, claimId: string): Promise<void> {
    await releaseTelegramAction(callbackData, claimId, new Date(this.now()));
  }

  idempotencyKey(decisionGroupId: string): string {
    return `telegram-decision:${decisionGroupId}`;
  }

  private createEntry(
    action: TelegramOperatorAction,
    sessionId: string,
    callId: string,
    decisionGroupId: string,
    expiresAt: Date,
  ): TelegramActionEntry {
    const callbackData = `tg:${this.createToken()}`;
    if (!isValidCallbackData(callbackData)) {
      throw new Error('Generated Telegram callback_data exceeds 64 bytes');
    }
    return { token: callbackData, decisionGroupId, target: { action, sessionId, callId }, expiresAt };
  }
}

function isValidCallbackData(callbackData: string): boolean {
  return Buffer.byteLength(callbackData, 'utf8') <= 64 && callbackData.startsWith('tg:');
}
