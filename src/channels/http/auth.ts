// auth.ts — SPEC-805 T1: bearer token generation, verification, and IP ban tracker.
// Token format: nmbt_<base64url(32 random bytes)>
// Uses crypto.timingSafeEqual to prevent timing attacks on token comparison.

import { getBest } from '../../platform/secrets/index.ts';
import { logger } from '../../observability/logger.ts';

const TOKEN_PREFIX = 'nmbt_';
const TOKEN_BYTE_LENGTH = 32;

// IP ban: 10 failures/min per IP → 15-min ban
const MAX_FAILURES_PER_MIN = 10;
const FAILURE_WINDOW_MS = 60_000;
const BAN_DURATION_MS = 15 * 60 * 1000;
const MAX_IP_ENTRIES = 10_000; // LRU cap — prevent memory DoS

interface IpEntry {
  failures: number[];   // timestamps of failures within the window
  bannedUntil: number;  // epoch ms; 0 = not banned
  lastSeen: number;     // for LRU eviction
}

// In-memory store — resets on process restart (acceptable per spec §3).
const ipMap = new Map<string, IpEntry>();

function evictLruEntry(): void {
  if (ipMap.size <= MAX_IP_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [k, v] of ipMap) {
    if (v.lastSeen < oldestTs) {
      oldestTs = v.lastSeen;
      oldestKey = k;
    }
  }
  if (oldestKey !== null) ipMap.delete(oldestKey);
}

function getOrCreateEntry(ip: string): IpEntry {
  let entry = ipMap.get(ip);
  if (!entry) {
    entry = { failures: [], bannedUntil: 0, lastSeen: Date.now() };
    ipMap.set(ip, entry);
    evictLruEntry();
  }
  return entry;
}

/** Generate a new `nmbt_<base64url>` bearer token. */
export function generateBearerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTE_LENGTH));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${TOKEN_PREFIX}${b64}`;
}

/** Store the bearer token for a workspace in the platform secret store. */
export async function storeBearerToken(workspaceId: string, token: string): Promise<void> {
  const store = await getBest();
  await store.set('nimbus-http', `bearer.${workspaceId}`, token);
}

/** Retrieve the stored bearer token for a workspace, or null if none. */
export async function loadBearerToken(workspaceId: string): Promise<string | null> {
  try {
    const store = await getBest();
    return await store.get('nimbus-http', `bearer.${workspaceId}`);
  } catch {
    return null;
  }
}

/** Constant-time bearer token verification.
 *  Returns false if no token stored or token doesn't match. */
export async function verifyBearer(token: string, workspaceId: string): Promise<boolean> {
  const stored = await loadBearerToken(workspaceId);
  if (stored === null) return false;
  // Encode both as UTF-8 bytes for timingSafeEqual (must be same length).
  const enc = new TextEncoder();
  const a = enc.encode(token.padEnd(100, '\0').slice(0, 100));
  const b = enc.encode(stored.padEnd(100, '\0').slice(0, 100));
  if (a.length !== b.length) return false;
  try {
    return crypto.subtle !== undefined
      ? timingSafeEqualBuffers(a, b) && token === stored
      : token === stored;
  } catch {
    return false;
  }
}

function timingSafeEqualBuffers(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Record a failed auth attempt for an IP.
 *  Returns ban status and remaining attempts before ban. */
export function recordFailedAuth(ip: string): { banned: boolean; remainingAttempts: number } {
  const now = Date.now();
  const entry = getOrCreateEntry(ip);
  entry.lastSeen = now;

  // Already banned?
  if (entry.bannedUntil > now) {
    logger.warn({ ip, bannedUntil: entry.bannedUntil }, 'auth attempt from banned IP');
    return { banned: true, remainingAttempts: 0 };
  }

  // Prune failures outside the window.
  entry.failures = entry.failures.filter((ts) => now - ts < FAILURE_WINDOW_MS);
  entry.failures.push(now);

  if (entry.failures.length >= MAX_FAILURES_PER_MIN) {
    entry.bannedUntil = now + BAN_DURATION_MS;
    entry.failures = [];
    logger.warn({ ip, banDurationMs: BAN_DURATION_MS }, 'IP banned due to excessive auth failures');
    return { banned: true, remainingAttempts: 0 };
  }

  const remaining = MAX_FAILURES_PER_MIN - entry.failures.length;
  return { banned: false, remainingAttempts: remaining };
}

/** Check if an IP is currently banned without recording a new failure. */
export function isIpBanned(ip: string): boolean {
  const entry = ipMap.get(ip);
  if (!entry) return false;
  return entry.bannedUntil > Date.now();
}

/** Mask token for safe logging: show prefix + last 4 chars only. */
export function maskToken(token: string): string {
  if (token.startsWith(TOKEN_PREFIX) && token.length > TOKEN_PREFIX.length + 4) {
    return `${TOKEN_PREFIX}***${token.slice(-4)}`;
  }
  return '***';
}

/** Reset in-memory ban map (test-only). */
export function __resetIpMap(): void {
  ipMap.clear();
}
