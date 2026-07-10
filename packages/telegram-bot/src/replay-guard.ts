export class TelegramReplayGuard {
  private readonly completed = new Map<string, true>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly maxCompletedKeys = 10_000) {}

  async runOnce(keys: readonly string[], operation: () => Promise<void>): Promise<boolean> {
    const uniqueKeys = [...new Set(keys.filter(Boolean))];
    if (uniqueKeys.length === 0) throw new Error('At least one Telegram replay key is required');
    if (uniqueKeys.some(key => this.completed.has(key))) {
      for (const key of uniqueKeys) this.remember(key);
      return false;
    }

    const existing = [...new Set(uniqueKeys.map(key => this.inFlight.get(key)).filter(Boolean))] as Promise<void>[];
    if (existing.length > 0) {
      const joined = Promise.all(existing).then(() => undefined);
      const aliases = uniqueKeys.filter(key => !this.inFlight.has(key));
      for (const key of aliases) this.inFlight.set(key, joined);
      try {
        await joined;
        for (const key of uniqueKeys) this.remember(key);
      } finally {
        for (const key of aliases) {
          if (this.inFlight.get(key) === joined) this.inFlight.delete(key);
        }
      }
      return false;
    }

    const current = operation();
    for (const key of uniqueKeys) this.inFlight.set(key, current);
    try {
      await current;
      for (const key of uniqueKeys) this.remember(key);
      return true;
    } finally {
      for (const key of uniqueKeys) {
        if (this.inFlight.get(key) === current) this.inFlight.delete(key);
      }
    }
  }

  private remember(key: string): void {
    this.completed.set(key, true);
    while (this.completed.size > this.maxCompletedKeys) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completed.delete(oldest);
    }
  }
}
