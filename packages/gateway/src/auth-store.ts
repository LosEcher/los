/**
 * Auth store — user CRUD, password hashing (scrypt), JWT signing/verification.
 *
 * Zero external dependencies: uses Node 22 built-in crypto for
 * - Password hashing: scrypt (memory-hard KDF)
 * - JWT: HMAC-SHA256 with base64url encoding
 *
 * JWT payload: { sub (userId), username, role, iat, exp }
 * Default expiry: 7 days.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('auth-store');

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: 'operator' | 'user';
  createdAt: string;
  updatedAt: string;
}

export interface JwtPayload {
  sub: string;   // userId
  username: string;
  role: 'operator' | 'user';
  iat: number;
  exp: number;
}

const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

// ── Password hashing ────────────────────────────────────

const SALT_BYTES = 16;
const HASH_BYTES = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = scryptSync(password, salt, HASH_BYTES).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const computed = scryptSync(password, salt, HASH_BYTES);
    const expected = Buffer.from(hash, 'hex');
    if (computed.length !== expected.length) return false;
    return timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

// ── JWT ─────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = { ...payload, iat: now, exp: now + JWT_EXPIRY_SECONDS };
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(Buffer.from(JSON.stringify(full)));
  const sigInput = `${header}.${body}`;
  const signature = createHmac('sha256', secret).update(sigInput).digest('base64url');
  return `${sigInput}.${signature}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, bodyB64, sigB64] = parts;
  const sigInput = `${headerB64}.${bodyB64}`;
  const expectedSig = createHmac('sha256', secret).update(sigInput).digest('base64url');

  const sigBuf = Buffer.from(sigB64);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload: JwtPayload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── User CRUD ───────────────────────────────────────────

export async function createUser(username: string, password: string, role: 'operator' | 'user' = 'user'): Promise<UserRecord> {
  const id = `user-${randomBytes(12).toString('hex')}`;
  const passwordHash = hashPassword(password);
  const db = getDb();
  await db.query(
    `INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)`,
    [id, username, passwordHash, role],
  );
  return { id, username, passwordHash, role, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const db = getDb();
  const result = await db.query(
    `SELECT id, username, password_hash, role, created_at, updated_at FROM users WHERE username = $1`,
    [username],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

export async function countUsers(): Promise<number> {
  const db = getDb();
  const result = await db.query(`SELECT COUNT(*) as count FROM users`);
  return parseInt(result.rows[0].count, 10);
}

export async function authenticateUser(username: string, password: string): Promise<{ user: UserRecord; token: string } | null> {
  const user = await findUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  const jwtSecret = getJwtSecret();
  const token = signJwt({ sub: user.id, username: user.username, role: user.role }, jwtSecret);
  return { user, token };
}

// ── JWT secret ──────────────────────────────────────────

let _jwtSecret: string | undefined;

export function getJwtSecret(): string {
  if (!_jwtSecret) {
    // Priority: env var → generate random secret (rotates on restart)
    _jwtSecret = process.env.LOS_JWT_SECRET || randomBytes(32).toString('hex');
    if (!process.env.LOS_JWT_SECRET) {
      log.warn('LOS_JWT_SECRET not set — using ephemeral secret. User sessions will expire on restart.');
    }
  }
  return _jwtSecret;
}

export function setJwtSecret(secret: string): void {
  _jwtSecret = secret;
}
