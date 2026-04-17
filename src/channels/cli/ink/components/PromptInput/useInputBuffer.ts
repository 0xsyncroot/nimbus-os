// useInputBuffer.ts — SPEC-841: Multi-line char buffer with cursor management.
// Array-of-lines model. Uses string-width for CJK/Vietnamese/emoji cursor math.
// Cursor-width is cached per line, invalidated on edit.

import { useState, useCallback, useRef } from 'react';
import stringWidth from 'string-width';

export interface BufferState {
  lines: readonly string[];
  cursorRow: number;
  cursorCol: number; // logical column (char index), NOT visual width
}

export interface UseInputBufferReturn {
  state: BufferState;
  insert: (char: string) => void;
  insertNewline: () => void;
  backspace: () => void;
  moveLeft: () => void;
  moveRight: () => void;
  moveUp: () => boolean; // returns false → caller should navigate history
  moveDown: () => boolean; // returns false → caller should navigate history
  moveHome: () => void;
  moveEnd: () => void;
  setValue: (value: string) => void;
  clear: () => void;
  getValue: () => string;
  getVisualWidth: (row: number) => number;
}

function splitValue(value: string): string[] {
  return value.includes('\n') ? value.split('\n') : [value];
}

export function useInputBuffer(): UseInputBufferReturn {
  const [lines, setLines] = useState<string[]>(['']);
  const [cursorRow, setCursorRow] = useState(0);
  const [cursorCol, setCursorCol] = useState(0);

  // Cache: widthCache[row] = visual width of lines[row]. -1 = invalid.
  const widthCache = useRef<Map<number, number>>(new Map());

  const invalidateCache = useCallback((row: number): void => {
    widthCache.current.delete(row);
  }, []);

  const getVisualWidth = useCallback(
    (row: number): number => {
      const cached = widthCache.current.get(row);
      if (cached !== undefined) return cached;
      const w = stringWidth(lines[row] ?? '');
      widthCache.current.set(row, w);
      return w;
    },
    [lines],
  );

  const insert = useCallback(
    (char: string): void => {
      setLines(prev => {
        const next = [...prev];
        const line = next[cursorRow] ?? '';
        next[cursorRow] = line.slice(0, cursorCol) + char + line.slice(cursorCol);
        invalidateCache(cursorRow);
        return next;
      });
      setCursorCol(c => c + 1);
    },
    [cursorRow, cursorCol, invalidateCache],
  );

  const insertNewline = useCallback((): void => {
    setLines(prev => {
      const next = [...prev];
      const line = next[cursorRow] ?? '';
      const before = line.slice(0, cursorCol);
      const after = line.slice(cursorCol);
      next.splice(cursorRow, 1, before, after);
      invalidateCache(cursorRow);
      return next;
    });
    setCursorRow(r => r + 1);
    setCursorCol(0);
  }, [cursorRow, cursorCol, invalidateCache]);

  const backspace = useCallback((): void => {
    setLines(prev => {
      const next = [...prev];
      if (cursorCol > 0) {
        const line = next[cursorRow] ?? '';
        // Remove grapheme cluster (handle multi-byte chars)
        const before = [...line.slice(0, cursorCol)];
        before.pop();
        next[cursorRow] = before.join('') + line.slice(cursorCol);
        invalidateCache(cursorRow);
        setCursorCol(c => Math.max(0, c - 1));
      } else if (cursorRow > 0) {
        // Merge with previous line
        const prevLine = next[cursorRow - 1] ?? '';
        const currLine = next[cursorRow] ?? '';
        const newCol = prevLine.length;
        next.splice(cursorRow - 1, 2, prevLine + currLine);
        invalidateCache(cursorRow - 1);
        setCursorRow(r => r - 1);
        setCursorCol(newCol);
      }
      return next;
    });
  }, [cursorRow, cursorCol, invalidateCache]);

  const moveLeft = useCallback((): void => {
    if (cursorCol > 0) {
      setCursorCol(c => c - 1);
    } else if (cursorRow > 0) {
      setCursorRow(r => r - 1);
      setLines(prev => {
        setCursorCol((prev[cursorRow - 1] ?? '').length);
        return prev;
      });
    }
  }, [cursorRow, cursorCol]);

  const moveRight = useCallback((): void => {
    setLines(prev => {
      const lineLen = (prev[cursorRow] ?? '').length;
      if (cursorCol < lineLen) {
        setCursorCol(c => c + 1);
      } else if (cursorRow < prev.length - 1) {
        setCursorRow(r => r + 1);
        setCursorCol(0);
      }
      return prev;
    });
  }, [cursorRow, cursorCol]);

  const moveUp = useCallback((): boolean => {
    if (cursorRow > 0) {
      setCursorRow(r => r - 1);
      setLines(prev => {
        const targetLen = (prev[cursorRow - 1] ?? '').length;
        setCursorCol(c => Math.min(c, targetLen));
        return prev;
      });
      return true;
    }
    return false; // boundary reached → navigate history
  }, [cursorRow]);

  const moveDown = useCallback((): boolean => {
    setLines(prev => {
      if (cursorRow < prev.length - 1) {
        setCursorRow(r => r + 1);
        const targetLen = (prev[cursorRow + 1] ?? '').length;
        setCursorCol(c => Math.min(c, targetLen));
        return prev;
      }
      return prev;
    });
    // Return false when already on last line
    return cursorRow < lines.length - 1;
  }, [cursorRow, lines.length]);

  const moveHome = useCallback((): void => {
    setCursorCol(0);
  }, []);

  const moveEnd = useCallback((): void => {
    setLines(prev => {
      setCursorCol((prev[cursorRow] ?? '').length);
      return prev;
    });
  }, [cursorRow]);

  const setValue = useCallback((value: string): void => {
    const newLines = splitValue(value);
    setLines(newLines);
    widthCache.current.clear();
    const lastRow = newLines.length - 1;
    setCursorRow(lastRow);
    setCursorCol((newLines[lastRow] ?? '').length);
  }, []);

  const clear = useCallback((): void => {
    setLines(['']);
    widthCache.current.clear();
    setCursorRow(0);
    setCursorCol(0);
  }, []);

  const getValue = useCallback((): string => {
    return lines.join('\n');
  }, [lines]);

  return {
    state: { lines, cursorRow, cursorCol },
    insert,
    insertNewline,
    backspace,
    moveLeft,
    moveRight,
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    setValue,
    clear,
    getValue,
    getVisualWidth,
  };
}
