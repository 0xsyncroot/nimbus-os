// IR helpers — pure functions over CanonicalBlock/Message (SPEC-201).
import type {
  CanonicalBlock,
  CanonicalBlockType,
  CanonicalMessage,
} from './types';

export function extractText(msg: CanonicalMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  let out = '';
  for (const b of msg.content) {
    if (b.type === 'text') out += b.text;
  }
  return out;
}

export function mergeAdjacentText(blocks: CanonicalBlock[]): CanonicalBlock[] {
  const result: CanonicalBlock[] = [];
  for (const b of blocks) {
    const prev = result[result.length - 1];
    if (b.type === 'text' && prev && prev.type === 'text') {
      const merged: CanonicalBlock = { type: 'text', text: prev.text + b.text };
      if (b.cacheHint !== undefined) merged.cacheHint = b.cacheHint;
      else if (prev.cacheHint !== undefined) merged.cacheHint = prev.cacheHint;
      result[result.length - 1] = merged;
    } else {
      result.push(b);
    }
  }
  return result;
}

export function splitByType<T extends CanonicalBlockType>(
  blocks: CanonicalBlock[],
  type: T,
): Extract<CanonicalBlock, { type: T }>[] {
  return blocks.filter((b): b is Extract<CanonicalBlock, { type: T }> =>
    b.type === type,
  );
}

export function isToolUse(
  b: CanonicalBlock,
): b is Extract<CanonicalBlock, { type: 'tool_use' }> {
  return b.type === 'tool_use';
}

export function isToolResult(
  b: CanonicalBlock,
): b is Extract<CanonicalBlock, { type: 'tool_result' }> {
  return b.type === 'tool_result';
}

export function isText(
  b: CanonicalBlock,
): b is Extract<CanonicalBlock, { type: 'text' }> {
  return b.type === 'text';
}

export function isThinking(
  b: CanonicalBlock,
): b is Extract<CanonicalBlock, { type: 'thinking' }> {
  return b.type === 'thinking';
}

export function isImage(
  b: CanonicalBlock,
): b is Extract<CanonicalBlock, { type: 'image' }> {
  return b.type === 'image';
}

// Rough token count (chars/4 heuristic) — bounded accuracy, documented in SPEC-203.
export function countTokensApprox(msgs: CanonicalMessage[]): number {
  let chars = 0;
  for (const m of msgs) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text' || b.type === 'thinking') chars += b.text.length;
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input).length + b.name.length;
      else if (b.type === 'tool_result') {
        chars +=
          typeof b.content === 'string'
            ? b.content.length
            : JSON.stringify(b.content).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ULID — pure TS implementation (Crockford base32, 48-bit time + 80-bit randomness).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

function encodeTime(now: number): string {
  let out = '';
  let n = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = n % 32;
    out = ENCODING[mod] + out;
    n = (n - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  let out = '';
  const bytes = new Uint8Array(RAND_LEN);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < RAND_LEN; i++) {
    out += ENCODING[bytes[i]! % 32];
  }
  return out;
}

export function newToolUseId(): string {
  return encodeTime(Date.now()) + encodeRandom();
}
