// useHistory.ts — SPEC-841: Command history navigation.
// Up/down at line boundary cycle through history entries.
// History entries are stored oldest→newest; index points to current entry.
// Index === history.length means "current live buffer" (no history selected).

import { useState, useCallback } from 'react';

export interface UseHistoryReturn {
  addEntry: (value: string) => void;
  navigateUp: (currentValue: string) => string | null; // null → already at oldest
  navigateDown: () => string | null; // null → back to live buffer
  resetIndex: () => void;
  historyLength: () => number;
}

const MAX_HISTORY = 200;

export function useHistory(): UseHistoryReturn {
  const [entries, setEntries] = useState<string[]>([]);
  // Index into entries; entries.length → live (not browsing history)
  const [index, setIndex] = useState<number>(0);
  // Stash for current live buffer when we start browsing
  const [liveStash, setLiveStash] = useState<string>('');

  const addEntry = useCallback((value: string): void => {
    if (value.trim() === '') return;
    setEntries(prev => {
      // Deduplicate: remove duplicate at tail
      const deduped = prev[prev.length - 1] === value ? prev.slice(0, -1) : prev;
      const next = [...deduped, value];
      // Enforce max history size
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setIndex(e => e + 1); // will be set to length after update
  }, []);

  const navigateUp = useCallback(
    (currentValue: string): string | null => {
      setEntries(prev => {
        const effectiveIndex = index === prev.length ? prev.length : index;
        // Save live stash when first going up
        if (effectiveIndex === prev.length) {
          setLiveStash(currentValue);
        }
        if (effectiveIndex <= 0) return prev;
        const newIdx = effectiveIndex - 1;
        setIndex(newIdx);
        return prev;
      });
      // Return entry synchronously using closure capture
      const newIdx = Math.max(0, index - 1);
      if (index === 0) return null;
      setIndex(newIdx);
      return entries[newIdx] ?? null;
    },
    [entries, index],
  );

  const navigateDown = useCallback((): string | null => {
    if (index >= entries.length) return null; // already at live
    const newIdx = index + 1;
    setIndex(newIdx);
    if (newIdx >= entries.length) {
      return liveStash; // restore live buffer
    }
    return entries[newIdx] ?? null;
  }, [entries, index, liveStash]);

  const resetIndex = useCallback((): void => {
    setIndex(entries.length);
    setLiveStash('');
  }, [entries.length]);

  const historyLength = useCallback((): number => entries.length, [entries]);

  return { addEntry, navigateUp, navigateDown, resetIndex, historyLength };
}
