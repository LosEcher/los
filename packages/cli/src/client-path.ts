import { resolve } from 'node:path';

export function resolveClientPath(value: string): string {
  return resolve(process.env.LOS_CLIENT_CWD ?? process.cwd(), value);
}
