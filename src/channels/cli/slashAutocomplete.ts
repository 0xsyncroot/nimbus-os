// slashAutocomplete.ts — SPEC-801 + SPEC-822 T6/T8/T9: slash command autocomplete dropdown for TTY REPL.
// Pure readline + ANSI, no new deps. Non-TTY falls back to caller's readline path.

import type { SlashCommand } from './slashCommands.ts';
import {
  renderList,
  renderArgCard,
  renderEmpty,
} from './slashRenderer.ts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface Autocomplete {
  /** Main entry — returns the complete line on Enter, null on EOF/close. */
  readLine(): Promise<string | null>;
  dispose(): void;
}

export type AutocompleteInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (b: boolean) => unknown;
  setEncoding?: (encoding: BufferEncoding) => unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
};

export interface AutocompleteOptions {
  input: AutocompleteInput;
  output: NodeJS.WritableStream;
  promptStr: () => string;
  commands: () => SlashCommand[];
  cols: () => number;
}

// ---------------------------------------------------------------------------
// SPEC-822 T8/T9: Feature flag + fallback detection
// ---------------------------------------------------------------------------

/**
 * Returns true when polished renderer should be used.
 * NIMBUS_SLASH_UI=plain forces old renderer.
 * Auto-fallback when: not TTY, cols < 60, or TERM=dumb.
 */
export function shouldUsePolishedRenderer(isTTY: boolean, cols: number): boolean {
  const flag = process.env['NIMBUS_SLASH_UI'];
  if (flag === 'plain') return false;
  if (process.env['TERM'] === 'dumb') return false;
  if (!isTTY) return false;
  if (cols < 60) return false;
  return true;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = '\x1b';
const SAVE_CURSOR = `${ESC}[s`;
const RESTORE_CURSOR = `${ESC}[u`;
const CLEAR_BELOW = `${ESC}[J`;
const INVERT_ON = `${ESC}[7m`;
const INVERT_OFF = `${ESC}[0m`;
const CLEAR_LINE = `${ESC}[2K\r`;

// ---------------------------------------------------------------------------
// Filter + sort helpers
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 10;

function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.slice(1).toLowerCase(); // strip leading /
  const filtered = commands.filter((c) => c.name.toLowerCase().includes(q));
  // Exact prefix first, then alphabetical
  filtered.sort((a, b) => {
    const aPrefix = a.name.toLowerCase().startsWith(q);
    const bPrefix = b.name.toLowerCase().startsWith(q);
    if (aPrefix && !bPrefix) return -1;
    if (!aPrefix && bPrefix) return 1;
    return a.name.localeCompare(b.name);
  });
  return filtered;
}

function shouldOpenDropdown(buffer: string): boolean {
  return /^\/\w*$/.test(buffer);
}

// ---------------------------------------------------------------------------
// Dropdown render
// ---------------------------------------------------------------------------

interface DropdownState {
  isOpen: boolean;
  selectedName: string | null;
  scrollTop: number;
}

function renderDropdown(
  output: NodeJS.WritableStream,
  filtered: SlashCommand[],
  state: DropdownState,
  promptLen: number,
  bufferLen: number,
  cols: number,
): void {
  if (!state.isOpen || filtered.length === 0) return;

  const visible = filtered.slice(state.scrollTop, state.scrollTop + MAX_VISIBLE);
  const maxNameLen = Math.max(...visible.map((c) => c.name.length), 4);
  const maxWidth = Math.min(cols - 2, 72);

  let out = '';
  for (let i = 0; i < visible.length; i++) {
    const cmd = visible[i]!;
    const isSelected = cmd.name === state.selectedName;
    const nameCol = `/${cmd.name}`.padEnd(maxNameLen + 2);
    const descAvail = maxWidth - nameCol.length - 3;
    const desc = descAvail > 0 ? cmd.description.slice(0, descAvail) : '';
    const row = `  ${nameCol}  ${desc}`;
    out += '\n';
    out += CLEAR_LINE;
    if (isSelected) out += INVERT_ON;
    out += row;
    if (isSelected) out += INVERT_OFF;
  }
  // scroll indicator
  if (filtered.length > MAX_VISIBLE) {
    const showing = `${state.scrollTop + 1}-${Math.min(state.scrollTop + MAX_VISIBLE, filtered.length)}/${filtered.length}`;
    out += `\n${CLEAR_LINE}  ${showing}`;
  }
  output.write(out);
}

// ---------------------------------------------------------------------------
// Key parsing
// ---------------------------------------------------------------------------

type KeyEvent =
  | { type: 'char'; ch: string }
  | { type: 'enter' }
  | { type: 'tab' }
  | { type: 'esc' }
  | { type: 'backspace' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'ctrl_c' }
  | { type: 'paste'; text: string }
  | { type: 'unknown' };

function parseKey(s: string): KeyEvent {
  if (s === '\r' || s === '\n') return { type: 'enter' };
  if (s === '\t') return { type: 'tab' };
  if (s === '\x7f' || s === '\b') return { type: 'backspace' };
  if (s === '\x03') return { type: 'ctrl_c' };
  if (s === ESC) return { type: 'esc' };
  if (s === `${ESC}[A`) return { type: 'up' };
  if (s === `${ESC}[B`) return { type: 'down' };
  // multi-byte that starts with ESC but isn't an arrow → treat as unknown
  if (s.startsWith(ESC)) return { type: 'unknown' };
  // printable ASCII or UTF-8
  if (s.length > 1) return { type: 'paste', text: s };
  const cp = s.codePointAt(0) ?? 0;
  if (cp >= 0x20) return { type: 'char', ch: s };
  return { type: 'unknown' };
}

// ---------------------------------------------------------------------------
// createAutocomplete
// ---------------------------------------------------------------------------

export function createAutocomplete(opts: AutocompleteOptions): Autocomplete {
  const { input, output, promptStr, commands, cols } = opts;

  let disposed = false;
  let rawModeActive = false;
  let resolveReadLine: ((val: string | null) => void) | null = null;

  // Mutable state (functional via closure)
  let buffer = '';
  let dropdownState: DropdownState = { isOpen: false, selectedName: null, scrollTop: 0 };
  let filtered: SlashCommand[] = [];
  let renderLock: Promise<void> = Promise.resolve();
  // SPEC-822 T6: track last rendered lines for partial redraw diff
  let lastRenderedLines: string[] = [];

  function safeWrite(fn: () => void): void {
    renderLock = renderLock.then(() => {
      fn();
    }).catch(() => {
      // swallow render errors — never break the renderLock chain
    });
  }

  function getPromptLen(): number {
    // strip ANSI for length
    return promptStr().replace(/\x1b\[[0-9;]*m/g, '').length;
  }

  function recomputeDropdown(): void {
    if (!shouldOpenDropdown(buffer)) {
      dropdownState = { ...dropdownState, isOpen: false };
      filtered = [];
      return;
    }
    filtered = filterCommands(commands(), buffer);
    if (filtered.length === 0) {
      dropdownState = { ...dropdownState, isOpen: false };
      return;
    }
    dropdownState = { ...dropdownState, isOpen: true };
    // keep selectedName if it's still in filtered list; otherwise pick first
    const stillPresent = dropdownState.selectedName !== null &&
      filtered.some((c) => c.name === dropdownState.selectedName);
    if (!stillPresent) {
      dropdownState = { ...dropdownState, selectedName: filtered[0]?.name ?? null };
    }
    // adjust scrollTop so selection is visible
    const selIdx = filtered.findIndex((c) => c.name === dropdownState.selectedName);
    if (selIdx >= 0) {
      if (selIdx < dropdownState.scrollTop) {
        dropdownState = { ...dropdownState, scrollTop: selIdx };
      } else if (selIdx >= dropdownState.scrollTop + MAX_VISIBLE) {
        dropdownState = { ...dropdownState, scrollTop: selIdx - MAX_VISIBLE + 1 };
      }
    }
  }

  function redraw(): void {
    const prompt = promptStr();
    const currentCols = cols();
    const isTTY = (input as { isTTY?: boolean }).isTTY === true;
    const polished = shouldUsePolishedRenderer(isTTY, currentCols);

    // BUG FIX: don't SAVE_CURSOR/RESTORE_CURSOR + moveCursorRight around the
    // redraw. SAVE captures the PRE-redraw cursor position (often wrong after
    // a prior dropdown render). RESTORE then moveRight compounds the error,
    // pushing cursor past end-of-buffer → visible padding spaces on each
    // keystroke. The redraw writes prompt+buffer starting at col 0; after
    // that write, cursor is exactly at end-of-buffer already — no
    // repositioning needed.
    const out = '\r' + CLEAR_LINE + CLEAR_BELOW + prompt + buffer;
    output.write(out);

    if (polished) {
      // SPEC-822 T2/T3/T4/T6: polished renderer.
      // v0.3.3 fix (legend duplication): previous partial-redraw via diffAndWrite
      // assumed cursor was at bottom of block, but the outer `\r + CLEAR_LINE +
      // CLEAR_BELOW + prompt + buffer` just cleared everything below and put
      // cursor at end-of-buffer. diffAndWrite would then move cursor UP past the
      // prompt into scrollback and paint the new dropdown there — while the
      // OLD legend stayed visible below. Result: multiple legends on screen.
      //
      // Fix: since CLEAR_BELOW already wiped prior dropdown, do a clean full
      // paint every time. Write lines BELOW prompt, then cursor-up back to
      // end of buffer. `lastRenderedLines` is now only used to decide whether
      // to do cursor-up (avoid inserting a spurious `\r` when nothing drawn).
      let nextLines: string[] = [];

      // Detect render state from buffer shape
      const argCardMatch = buffer.match(/^\/(\w[\w-]*)\s+/);
      if (argCardMatch) {
        // trailing-space state: find the command
        const cmdName = argCardMatch[1]!;
        const cmd = commands().find((c) => c.name === cmdName);
        if (cmd) {
          nextLines = renderArgCard(cmd, currentCols);
        }
      } else if (buffer === '/') {
        // empty state: bare '/'
        nextLines = renderEmpty(commands(), currentCols);
      } else if (dropdownState.isOpen && filtered.length > 0) {
        // list state: filter active
        const selIdx = filtered.findIndex((c) => c.name === dropdownState.selectedName);
        nextLines = renderList({ kind: 'list', filtered, selected: selIdx >= 0 ? selIdx : 0 }, currentCols);
      }

      if (nextLines.length > 0) {
        // Write a leading newline (move below prompt row), then each line
        // prefixed with erase-line so stale content goes. After last line,
        // cursor is at col 0 of the row below the block. Cursor-up
        // (nextLines.length + 1) rows returns to the prompt row at col 0;
        // cursor-forward positions at end-of-buffer so the next keystroke
        // appends naturally.
        let paint = '\n';
        for (const line of nextLines) {
          paint += `\r${ESC}[2K${line}\n`;
        }
        paint += `${ESC}[${nextLines.length + 1}A`;
        const promptVisLen = prompt.replace(/\x1b\[[0-9;]*m/g, '').length;
        const col = promptVisLen + buffer.length;
        if (col > 0) paint += `${ESC}[${col}C`;
        output.write(paint);
      }
      lastRenderedLines = nextLines;
    } else {
      // Legacy renderer (T8/T9 fallback)
      if (dropdownState.isOpen && filtered.length > 0) {
        output.write(SAVE_CURSOR);
        renderDropdown(output, filtered, dropdownState, getPromptLen(), buffer.length, currentCols);
        output.write(RESTORE_CURSOR);
      }
    }
  }

  function selectUp(): void {
    if (!dropdownState.isOpen || filtered.length === 0) return;
    const idx = filtered.findIndex((c) => c.name === dropdownState.selectedName);
    const newIdx = idx <= 0 ? filtered.length - 1 : idx - 1;
    dropdownState = { ...dropdownState, selectedName: filtered[newIdx]?.name ?? null };
    // adjust scroll
    if (newIdx < dropdownState.scrollTop) {
      dropdownState = { ...dropdownState, scrollTop: newIdx };
    } else if (newIdx >= dropdownState.scrollTop + MAX_VISIBLE) {
      dropdownState = { ...dropdownState, scrollTop: newIdx - MAX_VISIBLE + 1 };
    }
  }

  function selectDown(): void {
    if (!dropdownState.isOpen || filtered.length === 0) return;
    const idx = filtered.findIndex((c) => c.name === dropdownState.selectedName);
    const newIdx = idx < 0 || idx >= filtered.length - 1 ? 0 : idx + 1;
    dropdownState = { ...dropdownState, selectedName: filtered[newIdx]?.name ?? null };
    // adjust scroll
    if (newIdx < dropdownState.scrollTop) {
      dropdownState = { ...dropdownState, scrollTop: newIdx };
    } else if (newIdx >= dropdownState.scrollTop + MAX_VISIBLE) {
      dropdownState = { ...dropdownState, scrollTop: newIdx - MAX_VISIBLE + 1 };
    }
  }

  function onData(data: string): void {
    if (disposed || !resolveReadLine) return;

    // Paste detection: only true multi-byte sequences (>1 char in a single write) are treated
    // as paste and collapse the dropdown. Single chars always go through normal key processing
    // so the dropdown state is correctly maintained regardless of typing speed.

    const key = parseKey(data);

    if (key.type === 'paste') {
      buffer += key.text;
      dropdownState = { isOpen: false, selectedName: null, scrollTop: 0 };
      filtered = [];
      safeWrite(() => redraw());
      return;
    }

    if (key.type === 'ctrl_c') {
      cleanup();
      resolveReadLine(null);
      resolveReadLine = null;
      return;
    }

    if (key.type === 'enter') {
      const result = buffer;
      dropdownState = { isOpen: false, selectedName: null, scrollTop: 0 };
      filtered = [];
      lastRenderedLines = [];
      safeWrite(() => {
        // clear dropdown lines and emit newline to finalize
        output.write(`${SAVE_CURSOR}${CLEAR_BELOW}${RESTORE_CURSOR}`);
        output.write('\n');
      });
      cleanup();
      resolveReadLine(result);
      resolveReadLine = null;
      return;
    }

    if (key.type === 'tab') {
      if (dropdownState.isOpen && dropdownState.selectedName !== null) {
        buffer = `/${dropdownState.selectedName} `;
        dropdownState = { isOpen: false, selectedName: null, scrollTop: 0 };
        filtered = [];
        safeWrite(() => redraw());
      }
      return;
    }

    if (key.type === 'esc') {
      dropdownState = { ...dropdownState, isOpen: false };
      lastRenderedLines = [];
      safeWrite(() => redraw());
      return;
    }

    if (key.type === 'up') {
      selectUp();
      safeWrite(() => redraw());
      return;
    }

    if (key.type === 'down') {
      selectDown();
      safeWrite(() => redraw());
      return;
    }

    if (key.type === 'backspace') {
      if (buffer.length > 0) {
        buffer = buffer.slice(0, -1);
      }
      if (buffer.length === 0) {
        dropdownState = { isOpen: false, selectedName: null, scrollTop: 0 };
        filtered = [];
      } else {
        recomputeDropdown();
      }
      safeWrite(() => redraw());
      return;
    }

    if (key.type === 'char') {
      buffer += key.ch;
      recomputeDropdown();
      safeWrite(() => redraw());
      return;
    }

    // unknown — ignore
  }

  function cleanup(): void {
    if (rawModeActive) {
      try {
        if (typeof input.setRawMode === 'function') {
          input.setRawMode(false);
        }
      } catch {
        // ignore
      }
      rawModeActive = false;
    }
    input.removeListener('data', onData);
  }

  function readLine(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      if (disposed) {
        resolve(null);
        return;
      }

      // Gate: dumb terminal
      if (process.env['TERM'] === 'dumb') {
        resolve(null);
        return;
      }

      resolveReadLine = resolve;
      buffer = '';
      dropdownState = { isOpen: false, selectedName: null, scrollTop: 0 };
      filtered = [];
      lastRenderedLines = [];

      // Enable raw mode
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(true);
        rawModeActive = true;
      }

      if (typeof input.setEncoding === 'function') input.setEncoding('utf8');
      input.on('data', onData);

      // Draw initial prompt
      safeWrite(() => {
        output.write(`\r${CLEAR_LINE}${promptStr()}`);
      });
    });
  }

  function dispose(): void {
    disposed = true;
    cleanup();
    if (resolveReadLine) {
      resolveReadLine(null);
      resolveReadLine = null;
    }
  }

  return { readLine, dispose };
}
