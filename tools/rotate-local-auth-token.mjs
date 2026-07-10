#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKEN_KEY = 'LOS_AUTH_TOKEN';
const REDACTED = '[REDACTED_ROTATED]';
const SENSITIVE_HEADER_PATTERN = /(\"(?:authorization|cookie|set-cookie|x-los-auth-token|x-los-operator-token)\"\s*:\s*\")[^\"]*(\")/gi;

export function readEnvValue(content, key) {
  const line = content.split(/\r?\n/).find(candidate => candidate.startsWith(`${key}=`));
  return line?.slice(key.length + 1);
}

export function replaceEnvValue(content, key, value) {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex(line => line.startsWith(`${key}=`));
  if (index < 0) throw new Error(`${key} is not configured`);
  lines[index] = `${key}=${value}`;
  return lines.join('\n');
}

export function tokenFingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function atomicWrite(file, content, mode) {
  const temporary = join(dirname(file), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, file);
}

function loadState(root, home) {
  const envFile = join(root, '.env');
  if (!existsSync(envFile)) throw new Error(`Missing ${envFile}`);
  const envContent = readFileSync(envFile, 'utf8');
  const authToken = readEnvValue(envContent, TOKEN_KEY);
  if (!authToken) throw new Error(`${TOKEN_KEY} is empty or missing in ${envFile}`);

  const weclawFile = join(home, '.weclaw', 'config.json');
  let weclawConfig;
  if (existsSync(weclawFile)) {
    weclawConfig = JSON.parse(readFileSync(weclawFile, 'utf8'));
  }

  const gatewayLog = join(root, '.los-runtime', 'gateway.log');
  const gatewayLogContent = existsSync(gatewayLog) ? readFileSync(gatewayLog, 'utf8') : undefined;

  return { envFile, envContent, authToken, weclawFile, weclawConfig, gatewayLog, gatewayLogContent };
}

export function inspectLocalAuthToken({ root = process.cwd(), home = homedir() } = {}) {
  const state = loadState(resolve(root), home);
  const weclawToken = state.weclawConfig?.agents?.los?.api_key;
  const sensitiveHeaderCount = state.gatewayLogContent?.match(SENSITIVE_HEADER_PATTERN)?.length ?? 0;
  const tokenOccurrences = state.gatewayLogContent?.split(state.authToken).length - 1 || 0;
  return {
    envFile: state.envFile,
    tokenLength: state.authToken.length,
    fingerprint: tokenFingerprint(state.authToken),
    weclawFile: existsSync(state.weclawFile) ? state.weclawFile : undefined,
    weclawMatches: typeof weclawToken === 'string' && weclawToken === state.authToken,
    gatewayLog: existsSync(state.gatewayLog) ? state.gatewayLog : undefined,
    sensitiveHeaderCount,
    tokenOccurrences,
  };
}

export function rotateLocalAuthToken({
  root = process.cwd(),
  home = homedir(),
  newToken = randomBytes(32).toString('hex'),
} = {}) {
  if (newToken.length < 32) throw new Error('Refusing to install an auth token shorter than 32 characters');

  const state = loadState(resolve(root), home);
  if (newToken === state.authToken) throw new Error('New auth token must differ from the current token');

  atomicWrite(state.envFile, replaceEnvValue(state.envContent, TOKEN_KEY, newToken), 0o600);

  let weclawUpdated = false;
  if (state.weclawConfig?.agents?.los?.api_key === state.authToken) {
    state.weclawConfig.agents.los.api_key = newToken;
    const mode = statSync(state.weclawFile).mode & 0o777;
    atomicWrite(state.weclawFile, `${JSON.stringify(state.weclawConfig, null, 2)}\n`, mode || 0o600);
    weclawUpdated = true;
  }

  let gatewayLogUpdated = false;
  if (state.gatewayLogContent !== undefined) {
    const sanitized = state.gatewayLogContent
      .split(state.authToken).join(REDACTED)
      .replace(SENSITIVE_HEADER_PATTERN, `$1${REDACTED}$2`);
    if (sanitized !== state.gatewayLogContent) {
      const mode = statSync(state.gatewayLog).mode & 0o777;
      atomicWrite(state.gatewayLog, sanitized, mode || 0o600);
      gatewayLogUpdated = true;
    }
  }

  return {
    envFile: state.envFile,
    tokenLength: newToken.length,
    fingerprint: tokenFingerprint(newToken),
    weclawFile: weclawUpdated ? state.weclawFile : undefined,
    gatewayLog: gatewayLogUpdated ? state.gatewayLog : undefined,
  };
}

function printInspection(result) {
  console.log(`env: ${result.envFile}`);
  console.log(`token: configured length=${result.tokenLength} fingerprint=${result.fingerprint}`);
  console.log(`weclaw: ${result.weclawFile ?? 'not found'} synchronized=${result.weclawMatches}`);
  console.log(`gateway log: ${result.gatewayLog ?? 'not found'} sensitive_headers=${result.sensitiveHeaderCount} configured_token_occurrences=${result.tokenOccurrences}`);
}

function printRotation(result) {
  console.log(`rotated: ${result.envFile}`);
  if (result.weclawFile) console.log(`synchronized: ${result.weclawFile}`);
  if (result.gatewayLog) console.log(`sanitized: ${result.gatewayLog}`);
  console.log(`new token: length=${result.tokenLength} fingerprint=${result.fingerprint}`);
  console.log('restart required: pnpm restart and restart any bot process that imported .env');
}

function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node tools/rotate-local-auth-token.mjs [--check]');
    return;
  }
  if (process.argv.includes('--check')) {
    printInspection(inspectLocalAuthToken());
    return;
  }
  printRotation(rotateLocalAuthToken());
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) main();
