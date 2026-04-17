// picker.ts — SPEC-901 v0.2.1: generic TTY picker for init wizard.
// Extracted from src/catalog/picker.ts pattern — ↑↓ navigate, Enter select, 'c' custom, 's' skip.
// v0.3.10: shortcuts option + confirmPick() helper for single-char confirm without readline double-echo.

export interface PickerItem<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface PickerOpts {
  default?: number;
  allowCustom?: boolean;
  allowSkip?: boolean;
  /** Maps lowercase char → item index. Resolved before arrow-key logic. Uppercase also mapped via toLowerCase. */
  shortcuts?: Record<string, number>;
}

type PickerIO = {
  input?: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
};

const CTRL_C = '\u0003';
const ESC = '\u001b';
const ARROW_UP = `${ESC}[A`;
const ARROW_DOWN = `${ESC}[B`;
const CR = '\r';
const LF = '\n';

export type PickOneResult<T> = T | { custom: string } | 'skip';

/** Four-way confirm picker used for tool-permission prompts.
 *  v0.3.13: rewrite with proper chunk-to-keystroke parser. Prior versions had
 *  a readKey() that treated an entire 'data' chunk as ONE key — a chunk like
 *  "n\r" (stray byte from prior REPL input concatenated with user's Enter)
 *  matched neither Enter nor shortcut → loop stalled or wrong branch. Fix:
 *  parseKeys() splits a chunk into discrete keystrokes (ANSI escape sequences
 *  kept atomic; all other bytes are individual keys) and the loop processes
 *  them sequentially, so buffered-byte + real-key combos work correctly.
 *  Arrow+Enter only (no single-char shortcuts — those fired on stray bytes).
 */
export async function confirmPick(
  question: string,
  io?: PickerIO,
): Promise<'allow' | 'deny' | 'always' | 'never'> {
  const items: PickerItem<'allow' | 'deny' | 'always' | 'never'>[] = [
    { value: 'allow', label: 'Yes' },
    { value: 'deny', label: 'No' },
    { value: 'always', label: 'Always' },
    { value: 'never', label: 'Never (deny + remember)' },
  ];
  const picked = await pickOne(question, items, { default: 0 }, io);
  if (picked === 'skip' || typeof picked === 'object') return 'deny';
  return picked;
}

export async function pickOne<T>(
  label: string,
  items: PickerItem<T>[],
  opts?: PickerOpts,
  io?: PickerIO,
): Promise<PickOneResult<T>> {
  const input = io?.input ?? process.stdin;
  const output = io?.output ?? process.stdout;
  const write = (s: string): void => { output.write(s); };
  const defaultIdx = opts?.default ?? 0;
  const allowCustom = opts?.allowCustom ?? false;
  const allowSkip = opts?.allowSkip ?? false;
  const shortcuts = opts?.shortcuts ?? {};

  const rawCapable = typeof (input as { setRawMode?: unknown }).setRawMode === 'function'
    && (input as { isTTY?: boolean }).isTTY === true;

  if (!rawCapable) {
    return nonTtyPick(label, items, defaultIdx, allowCustom, allowSkip, input, output, write);
  }

  return rawModePick(label, items, defaultIdx, allowCustom, allowSkip, shortcuts, input, output, write);
}

async function nonTtyPick<T>(
  label: string,
  items: PickerItem<T>[],
  defaultIdx: number,
  allowCustom: boolean,
  allowSkip: boolean,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  write: (s: string) => void,
): Promise<PickOneResult<T>> {
  write(`\n  ${label}:\n`);
  items.forEach((item, i) => {
    const hint = item.hint ? `  — ${item.hint}` : '';
    write(`    ${i + 1}. ${item.label}${hint}\n`);
  });
  const extras: string[] = [];
  if (allowCustom) extras.push("'c' custom");
  if (allowSkip) extras.push("'s' skip");
  const extrasStr = extras.length > 0 ? `, ${extras.join(', ')}` : '';
  write(`  Enter number (1-${items.length})${extrasStr} [${defaultIdx + 1}]: `);

  const raw = (await readLine(input, output)).trim();
  if (raw === 's' && allowSkip) return 'skip';
  if (raw === 'c' && allowCustom) {
    write('  Custom value: ');
    const custom = (await readLine(input, output)).trim();
    return { custom };
  }
  const idx = raw === '' ? defaultIdx : parseInt(raw, 10) - 1;
  if (Number.isFinite(idx) && idx >= 0 && idx < items.length) {
    return items[idx]!.value;
  }
  return items[defaultIdx]!.value;
}

async function rawModePick<T>(
  label: string,
  items: PickerItem<T>[],
  defaultIdx: number,
  allowCustom: boolean,
  allowSkip: boolean,
  shortcuts: Record<string, number>,
  input: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean },
  output: NodeJS.WritableStream,
  write: (s: string) => void,
): Promise<PickOneResult<T>> {
  const extras: string[] = ['↑↓ navigate', 'Enter select'];
  if (allowCustom) extras.push("'c' custom");
  if (allowSkip) extras.push("'s' skip");
  write(`\n  ${label} — ${extras.join(', ')}\n`);

  let cursor = defaultIdx;
  const pageSize = Math.min(items.length, 10);

  const render = (): void => {
    for (let i = 0; i < items.length; i++) {
      const mark = i === cursor ? '> ' : '  ';
      const hint = items[i]!.hint ? `  — ${items[i]!.hint}` : '';
      write(`  ${mark}${items[i]!.label}${hint}\n`);
    }
  };
  const unrender = (): void => {
    for (let i = 0; i < items.length; i++) write('\u001b[1A\u001b[2K');
  };

  render();
  input.setRawMode?.(true);
  (input as { resume?: () => void }).resume?.();

  // v0.3.13 fix: process chunks via a pending-keys queue so one 'data' event
  // carrying multiple keystrokes (e.g. "n\r" from buffered REPL byte + user
  // Enter) is parsed into individual keys and handled sequentially.
  return new Promise((resolve, reject) => {
    let pending: string[] = [];
    let settled = false;
    const done = (value: PickOneResult<T>): void => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.setRawMode?.(false);
      (input as { pause?: () => void }).pause?.();
      resolve(value);
    };
    const reject2 = (err: Error): void => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.setRawMode?.(false);
      (input as { pause?: () => void }).pause?.();
      reject(err);
    };

    const processKey = async (key: string): Promise<void> => {
      if (settled) return;
      if (key === CTRL_C) {
        if (allowSkip) { done('skip'); return; }
        done(items[defaultIdx]!.value);
        return;
      }
      if ((key === 's' || key === 'S') && allowSkip) {
        unrender();
        done('skip');
        return;
      }
      if ((key === 'c' || key === 'C') && allowCustom) {
        unrender();
        input.setRawMode?.(false);
        output.write('  Custom value: ');
        try {
          const custom = (await readLine(input, output)).trim();
          done({ custom });
        } catch (err) {
          reject2(err as Error);
        }
        return;
      }
      if (key === CR || key === LF) {
        unrender();
        done(items[cursor]!.value);
        return;
      }
      // Shortcut single-char dispatch (case-insensitive).
      if (key.length === 1 && key !== CTRL_C) {
        const lc = key.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(shortcuts, lc)) {
          const idx = shortcuts[lc]!;
          if (idx >= 0 && idx < items.length) {
            unrender();
            done(items[idx]!.value);
            return;
          }
        }
      }
      let moved = false;
      if (key === ARROW_UP && cursor > 0) { cursor--; moved = true; }
      else if (key === ARROW_DOWN && cursor < items.length - 1) { cursor++; moved = true; }
      if (moved) {
        void pageSize;
        unrender();
        render();
      }
      // Unknown key → ignore, continue waiting.
    };

    const drainPending = async (): Promise<void> => {
      while (pending.length > 0 && !settled) {
        const k = pending.shift()!;
        await processKey(k);
      }
    };

    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const keys = parseKeys(text);
      pending.push(...keys);
      void drainPending();
    };

    input.on('data', onData);
  });
}

/** Split a raw stdin chunk into individual keystroke strings. ANSI escape
 *  sequences (CSI arrows / function keys) are kept atomic; every other byte
 *  becomes its own key. Handles the common case where stdin delivers multiple
 *  keystrokes in one chunk (buffered input + user keystroke). */
function parseKeys(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\x1b' && i + 1 < text.length && text[i + 1] === '[') {
      // CSI sequence: ESC [ <...> <final byte in 0x40-0x7E>
      let j = i + 2;
      while (j < text.length) {
        const b = text.charCodeAt(j);
        j++;
        if (b >= 0x40 && b <= 0x7E) break;
      }
      out.push(text.slice(i, j));
      i = j;
    } else if (ch === '\x1b') {
      // Bare ESC (or ESC followed by non-[ — treat as ESC alone, rest as separate)
      out.push(ch);
      i++;
    } else {
      out.push(ch);
      i++;
    }
  }
  return out;
}

// Exported for testing.
export const __testing = { parseKeys };

async function readLine(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input, output, terminal: false });
  return new Promise((resolve) => {
    rl.question('', (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}
