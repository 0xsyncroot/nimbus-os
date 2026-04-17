// inputModes.ts — SPEC-841: Mode sigil detection at position 0.
// Sigils: '/' → slash, '@' → file-ref, '!' → bash, '#' → memory.
// Non-sigil input → 'text'.

export type InputMode = 'text' | 'slash' | 'file-ref' | 'bash' | 'memory';

// Sigil → mode map
const SIGIL_MAP: Readonly<Record<string, InputMode>> = {
  '/': 'slash',
  '@': 'file-ref',
  '!': 'bash',
  '#': 'memory',
} as const;

/**
 * getModeFromInput — inspects the first character of `raw`.
 * Returns 'text' when buffer is empty or starts with a non-sigil char.
 */
export function getModeFromInput(raw: string): InputMode {
  if (raw.length === 0) return 'text';
  const first = raw[0];
  if (first === undefined) return 'text';
  return SIGIL_MAP[first] ?? 'text';
}

/**
 * getValueFromInput — strips the leading sigil when the mode is not 'text'.
 * For 'text' mode the original value is returned unchanged.
 */
export function getValueFromInput(raw: string): string {
  const mode = getModeFromInput(raw);
  if (mode === 'text') return raw;
  return raw.slice(1);
}
