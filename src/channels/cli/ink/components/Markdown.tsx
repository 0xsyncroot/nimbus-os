// Markdown.tsx — SPEC-843: Streaming-safe marked-based markdown renderer.
// LRU cache (500 entries, Bun.hash/djb2 keyed). Fast-path skip for prose.
// ANSI/OSC stripper applied to ALL text on the render path.
// marked.lexer invoked ONCE on message_stop — never on partial deltas.
// marked safe config: { gfm: true, breaks: false, pedantic: false, async: false }.

import React from 'react';
import { Text } from 'ink';
import { marked } from 'marked';

// Configure marked for safe, predictable rendering
marked.setOptions({ gfm: true, breaks: false, pedantic: false, async: false });

// ── ANSI/OSC stripper (META-009 T22) ─────────────────────────────────────────
// Strip: CSI \x1b[...m, OSC \x1b]...\x07, C1 \x9b
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x9b[0-9;]*[a-zA-Z]/g;

export function stripAnsiOsc(text: string): string {
  return text.replace(ANSI_RE, '');
}

// ── Fast-path skip regex ───────────────────────────────────────────────────────
// If the first 500 chars contain none of these MD markers, skip the lexer.
const MD_SYNTAX_RE = /[#*`|[\]>_\-~]|\n\n|^\d+\. |\n\d+\. /m;

export function hasMdSyntax(text: string): boolean {
  return MD_SYNTAX_RE.test(text.length > 500 ? text.slice(0, 500) : text);
}

// ── LRU cache ─────────────────────────────────────────────────────────────────
const LRU_MAX = 500;

// Doubly-linked list node for O(1) LRU eviction
interface LruNode {
  key: string;
  value: string;
  prev: LruNode | null;
  next: LruNode | null;
}

const lruMap = new Map<string, LruNode>();
let lruHead: LruNode | null = null; // most recently used
let lruTail: LruNode | null = null; // least recently used

function lruGet(key: string): string | undefined {
  const node = lruMap.get(key);
  if (!node) return undefined;
  // Move to head
  if (node !== lruHead) {
    detachNode(node);
    prependNode(node);
  }
  return node.value;
}

function lruSet(key: string, value: string): void {
  let node = lruMap.get(key);
  if (node) {
    node.value = value;
    if (node !== lruHead) {
      detachNode(node);
      prependNode(node);
    }
    return;
  }
  node = { key, value, prev: null, next: null };
  lruMap.set(key, node);
  prependNode(node);
  if (lruMap.size > LRU_MAX) {
    // Evict LRU (tail)
    if (lruTail) {
      lruMap.delete(lruTail.key);
      detachNode(lruTail);
    }
  }
}

function detachNode(node: LruNode): void {
  if (node.prev) node.prev.next = node.next;
  else lruHead = node.next;
  if (node.next) node.next.prev = node.prev;
  else lruTail = node.prev;
  node.prev = null;
  node.next = null;
}

function prependNode(node: LruNode): void {
  node.next = lruHead;
  node.prev = null;
  if (lruHead) lruHead.prev = node;
  lruHead = node;
  if (!lruTail) lruTail = node;
}

/** Exported for tests — clears LRU cache between test runs. */
export function clearMarkdownCache(): void {
  lruMap.clear();
  lruHead = null;
  lruTail = null;
}

/** Exported for tests — returns current cache size. */
export function markdownCacheSize(): number {
  return lruMap.size;
}

// ── Hash helper ───────────────────────────────────────────────────────────────
// Bun.hash (wyhash) on Bun runtime; djb2 as Node fallback. sha256 FORBIDDEN.

function hashText(text: string): string {
  if (typeof Bun !== 'undefined') {
    return String(Bun.hash(text));
  }
  // djb2 fallback for Node-based test environments
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return String(h);
}

// ── Render helper (exported for testing) ─────────────────────────────────────

/**
 * renderMarkdown — applies the full rendering pipeline:
 * 1. stripAnsiOsc
 * 2. fast-path check (no MD syntax → return raw text)
 * 3. LRU cache lookup
 * 4. marked.parse() on cache miss
 *
 * Only call this on COMPLETE (message_stop) text, never on streaming deltas.
 */
export function renderMarkdown(text: string): string {
  const stripped = stripAnsiOsc(text);
  if (!hasMdSyntax(stripped)) {
    return stripped;
  }
  const key = hashText(stripped);
  const cached = lruGet(key);
  if (cached !== undefined) return cached;

  // marked.parse is synchronous when async:false (configured above)
  let rendered: string;
  try {
    rendered = String(marked.parse(stripped));
  } catch {
    // Tolerate partial/malformed markdown — fall back to raw stripped text
    rendered = stripped;
  }
  lruSet(key, rendered);
  return rendered;
}

// ── Props ─────────────────────────────────────────────────────────────────────
export interface MarkdownProps {
  /** Full, complete text (post message_stop). Do NOT pass partial streaming deltas. */
  text: string;
  /** If true, renders raw stripped text (used for in-progress streaming deltas). */
  raw?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Markdown — renders assistant text with cached markdown parsing.
 *
 * raw=true  → strips ANSI/OSC only, returns plain text (for streaming in-progress).
 * raw=false → full renderMarkdown pipeline (LRU, fast-path, marked.parse).
 */
export const Markdown = React.memo(function Markdown({
  text,
  raw = false,
}: MarkdownProps): React.ReactElement {
  const display = raw ? stripAnsiOsc(text) : renderMarkdown(text);
  return <Text>{display}</Text>;
});

Markdown.displayName = 'NimbusMarkdown';
