// usePasteHandler.ts — SPEC-841: Paste handling with newline preservation.
// Uses Ink usePaste (ink#921). Large paste (≥LARGE_PASTE_THRESHOLD_BYTES bytes)
// → tokenized reference [Pasted N lines #id]; content stored in side buffer.
// Raw clipboard bytes NEVER re-fed to string-width per keystroke.

import { useCallback, useRef } from 'react';
import { usePaste } from 'ink';

export const LARGE_PASTE_THRESHOLD_BYTES = 10_000;

// Minimum line count to consider a paste "large" (independent of byte threshold)
const LARGE_PASTE_LINE_COUNT = 5;

let pasteCounter = 0;

export interface PasteEntry {
  id: string;
  lines: readonly string[];
  byteSize: number;
}

export interface UsePasteHandlerReturn {
  sideBuffer: Map<string, PasteEntry>;
  getPasteEntry: (id: string) => PasteEntry | undefined;
}

export interface UsePasteHandlerOpts {
  onPaste: (text: string) => void;
  isPassword?: boolean;
}

export function usePasteHandler({ onPaste, isPassword = false }: UsePasteHandlerOpts): UsePasteHandlerReturn {
  const sideBufferRef = useRef<Map<string, PasteEntry>>(new Map());

  const handlePaste = useCallback(
    (pasted: string): void => {
      // Password mode: never emit raw text; the PasswordInput component
      // handles masking internally. We still call onPaste so the buffer updates.
      if (isPassword) {
        // Only pass first line (before any newline) to prevent multiline injection
        const singleLine = pasted.split('\n')[0] ?? '';
        onPaste(singleLine);
        return;
      }

      const byteSize = Buffer.byteLength(pasted, 'utf8');
      const pasteLines = pasted.split('\n');

      // Large paste: tokenize
      if (byteSize >= LARGE_PASTE_THRESHOLD_BYTES || pasteLines.length >= LARGE_PASTE_LINE_COUNT) {
        pasteCounter += 1;
        const id = `paste-${pasteCounter}`;
        const entry: PasteEntry = { id, lines: pasteLines, byteSize };
        sideBufferRef.current.set(id, entry);
        const token = `[Pasted ${pasteLines.length} lines #${id}]`;
        onPaste(token);
        return;
      }

      // Normal paste: emit as-is (preserves newlines)
      onPaste(pasted);
    },
    [onPaste, isPassword],
  );

  usePaste(handlePaste);

  const getPasteEntry = useCallback(
    (id: string): PasteEntry | undefined => sideBufferRef.current.get(id),
    [],
  );

  return {
    sideBuffer: sideBufferRef.current,
    getPasteEntry,
  };
}
