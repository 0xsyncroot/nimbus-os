// memoryConsolidation.ts — SPEC-112: Dreaming Lite — heuristic end-of-session MEMORY.md consolidation.
// v0.2 "Lite": pure heuristic extraction, no LLM call.
// v0.5 "Full Dreaming" will add LLM-powered summarisation on top.

import { z } from 'zod';
import { logger } from '../observability/logger.ts';
import type { CanonicalMessage } from '../ir/types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ENTRIES_PER_SESSION = 10;
const SIMILARITY_THRESHOLD = 0.80; // Jaccard word-overlap for dedup

/** Prefixes (case-insensitive) that signal an explicitly memorable line. */
const EXPLICIT_PREFIXES = [
  'decision:',
  'remember:',
  'note:',
  'preference:',
];

/** Regex patterns for user corrections or explicit memory requests (EN + VI). */
const CORRECTION_RE = /\b(no[,\s]+i meant|actually[,\s]+|nhớ rằng|remember that)\b/i;

// ---------------------------------------------------------------------------
// Zod schemas & public types
// ---------------------------------------------------------------------------

export const ConsolidationResultSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
  skipped: z.boolean(),
  skipReason: z.enum(['low_turns', 'short_duration', 'cost_cap', 'disabled', 'timeout', 'error']).optional(),
  newEntries: z.array(z.string()),
  updatedMemory: z.string(),
  costUsd: z.number().default(0),
});
export type ConsolidationResult = z.infer<typeof ConsolidationResultSchema>;

export interface SessionStats {
  workspaceId: string;
  sessionId: string;
  turns: number;
  durationMs: number;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the plain-text of an assistant message content.
 * Handles both string content and CanonicalBlock arrays.
 */
function extractText(msg: CanonicalMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Tokenise a string to a word-bag for Jaccard similarity. */
function wordBag(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
}

/** Jaccard similarity between two strings. */
function jaccard(a: string, b: string): number {
  const ba = wordBag(a);
  const bb = wordBag(b);
  if (ba.size === 0 && bb.size === 0) return 1;
  let intersection = 0;
  for (const w of ba) {
    if (bb.has(w)) intersection++;
  }
  const union = ba.size + bb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Return true if the candidate is too similar to any existing memory line. */
function isDuplicate(candidate: string, existingLines: string[]): boolean {
  const cl = candidate.toLowerCase();
  for (const line of existingLines) {
    const ll = line.toLowerCase();
    // fast substring check first
    if (ll.includes(cl) || cl.includes(ll)) return true;
    if (jaccard(candidate, line) >= SIMILARITY_THRESHOLD) return true;
  }
  return false;
}

/**
 * Extract memorable candidate strings from a single text block.
 * Handles both assistant output and user messages.
 */
function extractCandidatesFromText(text: string, role: 'user' | 'assistant'): string[] {
  const candidates: string[] = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const lower = line.toLowerCase();

    // Explicit prefix triggers (both roles)
    const hasPrefix = EXPLICIT_PREFIXES.some((p) => lower.startsWith(p));
    if (hasPrefix) {
      // Strip the prefix label itself to get the fact
      const colonIdx = line.indexOf(':');
      const fact = line.slice(colonIdx + 1).trim();
      if (fact.length > 0) candidates.push(fact);
      continue;
    }

    // Corrections / explicit memory requests from user
    if (role === 'user' && CORRECTION_RE.test(line)) {
      candidates.push(line);
      continue;
    }

    // Assistant acknowledgement lines that carry a memorable fact
    if (role === 'assistant') {
      const ackRe = /\b(i'?ll remember|noted|got it[,—]|understood[,—])\b/i;
      if (ackRe.test(line)) {
        candidates.push(line);
        continue;
      }
    }
  }

  return candidates;
}

/** Parse existing MEMORY.md lines for dedup comparison. */
function parseExistingEntries(existingMemory: string): string[] {
  return existingMemory
    .split('\n')
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/**
 * Build an appended MEMORY.md string.
 * Appends a `## Session {date}` block under `# Observations` (created if absent).
 */
function buildUpdatedMemory(existingMemory: string, entries: string[], date: string): string {
  const block = `\n## Session ${date}\n` + entries.map((e) => `- ${e}`).join('\n') + '\n';

  const observationsHeaderRe = /^#\s+Observations\s*$/m;
  if (observationsHeaderRe.test(existingMemory)) {
    // Insert the block right after the `# Observations` heading line
    return existingMemory.replace(observationsHeaderRe, (match) => match + block);
  }

  // No `# Observations` section — append one at the end
  const separator = existingMemory.endsWith('\n') ? '' : '\n';
  return existingMemory + separator + '\n# Observations\n' + block;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Consolidate session messages into MEMORY.md entries using heuristic extraction.
 * Pure function — does NOT read/write files; callers handle I/O.
 *
 * @param sessionMessages - The full message list from the session.
 * @param existingMemory  - Current contents of workspace MEMORY.md.
 * @param stats           - Session metadata used for skip-guard checks.
 * @returns ConsolidationResult with `newEntries` and `updatedMemory`.
 */
export function consolidateMemory(
  sessionMessages: CanonicalMessage[],
  existingMemory: string,
  stats: Readonly<SessionStats>,
): ConsolidationResult {
  const base = {
    workspaceId: stats.workspaceId,
    sessionId: stats.sessionId,
    costUsd: 0,
  };

  // Skip guards (mirror SPEC-112 §2.1 trigger rules, relaxed for Lite)
  if (stats.turns < 2) {
    logger.info({ sessionId: stats.sessionId, reason: 'low_turns' }, 'dreaming-lite: skip consolidation');
    return { ...base, skipped: true, skipReason: 'low_turns', newEntries: [], updatedMemory: existingMemory };
  }
  if (stats.durationMs < 60_000) {
    logger.info({ sessionId: stats.sessionId, reason: 'short_duration' }, 'dreaming-lite: skip consolidation');
    return { ...base, skipped: true, skipReason: 'short_duration', newEntries: [], updatedMemory: existingMemory };
  }
  if (stats.costUsd >= 0.50) {
    logger.info({ sessionId: stats.sessionId, reason: 'cost_cap' }, 'dreaming-lite: skip consolidation');
    return { ...base, skipped: true, skipReason: 'cost_cap', newEntries: [], updatedMemory: existingMemory };
  }

  const existingLines = parseExistingEntries(existingMemory);

  // Collect candidates from all messages
  const rawCandidates: string[] = [];
  for (const msg of sessionMessages) {
    if (msg.role === 'system') continue;
    const text = extractText(msg);
    const found = extractCandidatesFromText(text, msg.role as 'user' | 'assistant');
    rawCandidates.push(...found);
  }

  // Dedup against existing memory + within candidates
  const seen: string[] = [...existingLines];
  const newEntries: string[] = [];

  for (const candidate of rawCandidates) {
    if (newEntries.length >= MAX_ENTRIES_PER_SESSION) break;
    if (isDuplicate(candidate, seen)) continue;
    newEntries.push(candidate);
    seen.push(candidate);
  }

  if (newEntries.length === 0) {
    logger.debug({ sessionId: stats.sessionId }, 'dreaming-lite: no new entries extracted');
    return { ...base, skipped: false, newEntries: [], updatedMemory: existingMemory };
  }

  const date = new Date().toISOString().slice(0, 10);
  const updatedMemory = buildUpdatedMemory(existingMemory, newEntries, date);

  logger.info({ sessionId: stats.sessionId, count: newEntries.length }, 'dreaming-lite: consolidated entries');
  return { ...base, skipped: false, newEntries, updatedMemory };
}

/**
 * Eligibility check: returns true when trigger rules pass.
 * Exposed separately for use by session-close hooks.
 */
export function isEligible(stats: { turns: number; durationMs: number; costUsd: number }): boolean {
  return stats.turns >= 2 && stats.durationMs >= 60_000 && stats.costUsd < 0.50;
}
