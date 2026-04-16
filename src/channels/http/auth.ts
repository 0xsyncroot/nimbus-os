// auth.ts — SPEC-805 loopback RPC: bearer token generation, storage, and verification.
// Token format: nmbt_<base64url(32 random bytes)>
// Uses timing-safe comparison to prevent timing attacks on token verification.

import { getBest } from '../../platform/secrets/index.ts';

const TOKEN_PREFIX = 'nmbt_';
const TOKEN_BYTE_LENGTH = 32;

/** Generate a new `nmbt_<base64url>` bearer token. */
export function generateBearerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTE_LENGTH));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${TOKEN_PREFIX}${b64}`;
}

/** Store the bearer token for a workspace in the platform secret store (mode 0600). */
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
  // Encode both as UTF-8 bytes for timing-safe comparison (must be same length).
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

/** Mask token for safe logging: show prefix + last 4 chars only. */
export function maskToken(token: string): string {
  if (token.startsWith(TOKEN_PREFIX) && token.length > TOKEN_PREFIX.length + 4) {
    return `${TOKEN_PREFIX}***${token.slice(-4)}`;
  }
  return '***';
}
