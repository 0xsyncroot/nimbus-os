// pairing.ts — SPEC-805 T2: 6-digit pairing code + optional QR + bearer token exchange.
// Code stored as PBKDF2(code, salt, 10000, 32) to prevent leakage via core dump.
// TTL: 5 minutes. One-time use.

import { generateBearerToken, storeBearerToken } from './auth.ts';
import { logger } from '../../observability/logger.ts';

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CODE_LENGTH = 6;

export interface PairingSession {
  /** 6-digit numeric string, e.g. "482039" */
  code: string;
  expiresAt: number;
  workspaceId: string;
}

interface StoredPairing {
  /** PBKDF2 hash of the code as hex string */
  hashHex: string;
  salt: string;
  expiresAt: number;
  workspaceId: string;
  redeemed: boolean;
}

// In-memory store — acceptable for v0.3 (single-process, local).
const sessions = new Map<string, StoredPairing>();

/** Generate a random 6-digit numeric code. */
function randomCode(): string {
  const arr = crypto.getRandomValues(new Uint32Array(1));
  return String((arr[0] ?? 0) % 1_000_000).padStart(CODE_LENGTH, '0');
}

/** Derive PBKDF2 hash of code with per-session salt. */
async function hashCode(code: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(code),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 10_000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return Array.from(new Uint8Array(derived))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Create a new pairing session. Returns the plaintext PairingSession for display. */
export async function createPairingSession(workspaceId: string): Promise<PairingSession> {
  // Invalidate any existing session for this workspace.
  for (const [key, s] of sessions) {
    if (s.workspaceId === workspaceId) sessions.delete(key);
  }

  const code = randomCode();
  const salt = crypto.randomUUID();
  const expiresAt = _now() + CODE_TTL_MS;
  const hashHex = await hashCode(code, salt);

  sessions.set(code.slice(0, 3), {
    hashHex,
    salt,
    expiresAt,
    workspaceId,
    redeemed: false,
  });

  logger.info({ workspaceId, expiresAt }, 'pairing session created');
  return { code, expiresAt, workspaceId };
}

/** Attempt to redeem a pairing code. Returns bearer token on success, null on failure. */
export async function redeemPairingCode(code: string): Promise<string | null> {
  if (code.length !== CODE_LENGTH || !/^\d+$/.test(code)) return null;

  const prefix = code.slice(0, 3);
  const stored = sessions.get(prefix);
  if (!stored) return null;
  if (stored.redeemed) return null;
  if (_now() > stored.expiresAt) {
    sessions.delete(prefix);
    logger.info({ prefix }, 'pairing code expired');
    return null;
  }

  // Hash the candidate and compare.
  const candidateHash = await hashCode(code, stored.salt);
  // Constant-time compare.
  if (!timingSafeStringEqual(candidateHash, stored.hashHex)) return null;

  stored.redeemed = true;
  sessions.delete(prefix);

  const token = generateBearerToken();
  await storeBearerToken(stored.workspaceId, token);
  logger.info({ workspaceId: stored.workspaceId }, 'pairing code redeemed; bearer token stored');
  return token;
}

/** Render a QR code for the pairing URL to stdout.
 *  Gracefully skips if NO_COLOR=1 or non-TTY. */
export function renderPairingQr(code: string, port: number): void {
  if (process.env['NO_COLOR'] === '1' || !process.stdout.isTTY) return;
  const url = `nimbus://pair?code=${code}&port=${port}`;
  // Minimal QR representation — print the URL so users can open it.
  // Full QR rendering requires `qrcode` package; v0.3 emits URI only.
  process.stdout.write(`\nPairing URL: ${url}\nCode: ${code}\n\n`);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  }
  return diff === 0;
}

/** Test-only: clear all sessions. */
export function __resetPairingSessions(): void {
  sessions.clear();
}

/** Test-only: inject clock for expiry testing. */
let _nowFn: () => number = () => Date.now();
export function __setNowFn(fn: () => number): void {
  _nowFn = fn;
}
export function _now(): number {
  return _nowFn();
}

