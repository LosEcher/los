import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export function resolveRuntimeCommand(command: string): string {
  if (isAbsolute(command) || command.includes('/')) return command;
  const candidates = [
    resolve(homedir(), '.local', 'bin', command),
    resolve('/opt/homebrew/bin', command),
    resolve('/usr/local/bin', command),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return command;
}
