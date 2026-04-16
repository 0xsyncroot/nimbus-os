// SPEC-206 T1 — bilingual (EN+VN) cue detector for reasoning-effort hint.
// Reuses SPEC-108 REASONING_CUE_WORDS semantics (high bucket) + adds low/minimal bucket.
// Word-boundary regex so `rethink` never matches `think`.

export type EffortLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

// Multi-word EN + VN phrases (matched as literal substrings after lowercasing since
// VN needs diacritic-aware matching and spaces — \b does not behave well with \p{M}).
// Phrases are first-checked against longest-prefix to avoid `think hard` masking `think`.
const HIGH_PHRASES_MULTIWORD: readonly string[] = [
  'think deeply',
  'think hard',
  'think harder',
  'deep think',
  'deeply think',
  'suy nghĩ kỹ',
  'suy nghi ky',
  'nghĩ sâu',
  'nghi sau',
  'phân tích sâu',
  'phan tich sau',
  'phân tích kỹ',
  'phan tich ky',
  'tư duy sâu',
  'tu duy sau',
];

const LOW_PHRASES_MULTIWORD: readonly string[] = [
  'trả lời nhanh',
  'tra loi nhanh',
  'ngắn gọn',
  'ngan gon',
];

// Single words (matched with \b) — easier for EN one-word tokens. VN single words
// include latin-only and accented variants.
const HIGH_WORDS: readonly string[] = ['ultrathink'];
const LOW_WORDS: readonly string[] = ['quick', 'quickly', 'rapid', 'briefly', 'short', 'nhanh', 'gọn', 'gon'];

const HIGH_WORDS_RE = new RegExp(`\\b(?:${HIGH_WORDS.join('|')})\\b`, 'iu');
const LOW_WORDS_RE = new RegExp(`\\b(?:${LOW_WORDS.join('|')})\\b`, 'iu');

/**
 * Strip `<tool_output>...</tool_output>` sections before scanning to avoid
 * indirect-injection of cue words (META-009 T2).
 */
function stripToolOutput(text: string): string {
  return text.replace(/<tool_output[\s\S]*?<\/tool_output>/gi, ' ');
}

export function detectReasoningCue(userMessage: string): EffortLevel | null {
  if (typeof userMessage !== 'string' || userMessage.length === 0) return null;
  const sanitized = stripToolOutput(userMessage).toLowerCase();
  for (const phrase of HIGH_PHRASES_MULTIWORD) {
    if (sanitized.includes(phrase)) return 'high';
  }
  if (HIGH_WORDS_RE.test(sanitized)) return 'high';
  for (const phrase of LOW_PHRASES_MULTIWORD) {
    if (sanitized.includes(phrase)) return 'low';
  }
  if (LOW_WORDS_RE.test(sanitized)) return 'low';
  return null;
}

// Exposed for tests + future SPEC-108 cross-reference.
export const __testing = {
  HIGH_PHRASES_MULTIWORD,
  LOW_PHRASES_MULTIWORD,
  HIGH_WORDS,
  LOW_WORDS,
};
