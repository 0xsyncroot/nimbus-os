// sessionPreferences.ts — SPEC-122: session-scoped preferences with meta.json persistence.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ErrorCode, NimbusError, wrapError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { workspacePaths } from './workspaceMemory.ts';

// ---------------------------------------------------------------------------
// Schema + Types
// ---------------------------------------------------------------------------

export const SessionPreferencesSchema = z.object({
  agentName: z.string().max(128).optional(),
  pronoun: z.string().max(64).optional(),
  language: z.string().max(32).optional(),
  voice: z.string().max(64).optional(),
});

export type SessionPreferences = z.infer<typeof SessionPreferencesSchema>;

// Block-marker pattern: [A-Z_]+ — detect prompt injection attempts
const BLOCK_MARKER_RE = /^\[?[A-Z_]{4,}\]?$/;
// Control-character pattern (excluding normal whitespace)
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

export function sanitizePrefValue(raw: string): string {
  let s = raw;
  // Strip HTML tags
  s = s.replace(/<[^>]*>/g, '');
  // Strip ANSI escape sequences
  s = s.replace(/[\u001b\u009b]\[[0-9;]*[A-Za-z]/g, '');
  // Truncate to 128 chars
  s = s.slice(0, 128);
  return s;
}

export function validatePrefValue(key: keyof SessionPreferences, value: string): void {
  const sanitized = sanitizePrefValue(value);
  if (CONTROL_CHAR_RE.test(sanitized)) {
    throw new NimbusError(ErrorCode.X_INJECTION, {
      reason: 'control_chars_in_pref_value',
      key,
    });
  }
  if (BLOCK_MARKER_RE.test(sanitized.trim())) {
    throw new NimbusError(ErrorCode.X_INJECTION, {
      reason: 'block_marker_in_pref_value',
      key,
      value: sanitized,
    });
  }
}

// ---------------------------------------------------------------------------
// Intent-phrase detection (for SPEC-122 cross-session promotion offer)
// ---------------------------------------------------------------------------

const INTENT_PHRASES_VI = ['từ giờ', 'từ nay', 'luôn luôn'];
const INTENT_PHRASES_EN = ['always call me', 'call me', 'refer to me as'];
const CROSS_SESSION_PHRASES = ['luôn luôn', 'always from now on', 'from now on always'];

export function detectSetPrefIntent(text: string): { key: keyof SessionPreferences; value: string } | null {
  const lower = text.toLowerCase();
  const allPhrases = [...INTENT_PHRASES_VI, ...INTENT_PHRASES_EN];
  for (const phrase of allPhrases) {
    if (lower.includes(phrase)) {
      // Extract name after the phrase
      const idx = lower.indexOf(phrase);
      const after = text.slice(idx + phrase.length).trim();
      const namePart = after.split(/[\s,./!?]+/)[0] ?? '';
      if (namePart.length > 0) {
        return { key: 'agentName', value: namePart };
      }
    }
  }
  return null;
}

export function detectCrossSessionIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return CROSS_SESSION_PHRASES.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// meta.json read/write helpers
// ---------------------------------------------------------------------------

interface SessionMetaJson {
  preferences?: SessionPreferences;
  [key: string]: unknown;
}

function sessionMetaPath(wsId: string, sessionId: string): string {
  return join(workspacePaths(wsId).sessionsDir, sessionId, 'meta.json');
}

async function readMetaJson(wsId: string, sessionId: string): Promise<SessionMetaJson> {
  const path = sessionMetaPath(wsId, sessionId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // File absent → treated as empty prefs (no migration needed for v0.1 sessions)
    return {};
  }
  try {
    return JSON.parse(raw) as SessionMetaJson;
  } catch (err) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, { reason: 'meta_json_corrupt', path }, err instanceof Error ? err : undefined);
  }
}

async function writeMetaJson(wsId: string, sessionId: string, data: SessionMetaJson): Promise<void> {
  const path = sessionMetaPath(wsId, sessionId);
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    throw wrapError(err, ErrorCode.S_CONFIG_INVALID, { reason: 'meta_json_write_failed', path });
  }
}

// ---------------------------------------------------------------------------
// In-process preferences cache
// ---------------------------------------------------------------------------

const prefsCache = new Map<string, SessionPreferences>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function setSessionPref(
  wsId: string,
  sessionId: string,
  key: keyof SessionPreferences,
  value: string,
): Promise<void> {
  validatePrefValue(key, value);
  const sanitized = sanitizePrefValue(value);

  // Read existing meta.json, merge, write back
  const meta = await readMetaJson(wsId, sessionId);
  const existing: SessionPreferences = meta.preferences ?? {};
  const updated: SessionPreferences = { ...existing, [key]: sanitized };

  // Validate the merged prefs with Zod
  const parsed = SessionPreferencesSchema.parse(updated);

  meta.preferences = parsed;
  await writeMetaJson(wsId, sessionId, meta);

  // Update in-memory cache
  prefsCache.set(sessionId, parsed);

  logger.debug({ wsId, sessionId, key }, 'sessionPref.set');
}

export async function getSessionPrefs(wsId: string, sessionId: string): Promise<SessionPreferences> {
  // Return from cache if present
  const cached = prefsCache.get(sessionId);
  if (cached) return cached;

  // Load from disk
  const meta = await readMetaJson(wsId, sessionId);
  const prefs = meta.preferences ? SessionPreferencesSchema.parse(meta.preferences) : {};
  prefsCache.set(sessionId, prefs);
  return prefs;
}

export function __resetPrefsCache(): void {
  prefsCache.clear();
}
