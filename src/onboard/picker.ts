// picker.ts — SPEC-901 v0.3.14: generic TTY picker for init wizard.
// Extracted from src/catalog/picker.ts pattern — ↑↓ navigate, Enter select, 'c' custom, 's' skip.
//
// v0.3.14 URGENT REWRITE: stop rolling our own keystroke parser. Use Node's
// built-in `readline.emitKeypressEvents(stream)` — the reference keypress
// parser used by Claude Code (via ink's `useInput`), `node:repl`, and
// virtually every interactive CLI in the Node ecosystem.
//
// What that gets us (for free):
//  * correct ANSI escape parsing across chunk splits (arrow keys delivered as
//    `\x1b` in one chunk and `[A` in the next — v0.3.13's parseKeys emitted
//    a bare ESC then later emitted unrelated bytes, causing the arrow to
//    land on the wrong action).
//  * proper multi-byte UTF-8 grouping (so Vietnamese "ỉ" doesn't fire a
//    stray single-byte shortcut).
//  * Ctrl+key recognition via the `key.ctrl` boolean (no magic `\u0003`
//    comparison).
//  * idempotent setup — calling emitKeypressEvents twice on the same stream
//    is a no-op, which matters because autocomplete and the picker both
//    touch stdin during a single REPL turn.
//
// History of failures this replaces:
//  * v0.3.10 double echo "yy" — handler attached before setRawMode(true).
//  * v0.3.11 autocomplete cleanup racing rawMode acquisition.
//  * v0.3.12 shortcut fired on stray buffered byte from prior REPL line.
//  * v0.3.13 parseKeys emitted wrong keys for chunk-split ANSI sequences.

import readline from 'node:readline';

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

export type PickOneResult<T> = T | { custom: string } | 'skip';

/** Four-way confirm picker used for tool-permission prompts.
 *  v0.3.14: arrow+Enter only (no single-char shortcuts — those fired on stray
 *  bytes from prior REPL input). Stray bytes are ignored by the keypress
 *  handler (unknown key → no state change). */
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

/** Shape of the key object emitted by readline's keypress parser.
 *  See https://nodejs.org/api/readline.html#readlineemitkeypresseventsstream-interface */
interface KeypressKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
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

  // Attach keypress parser. emitKeypressEvents is idempotent — safe to call
  // even if a prior autocomplete/readline has already installed a decoder on
  // this stream.
  readline.emitKeypressEvents(input);
  input.setRawMode?.(true);
  (input as { resume?: () => void }).resume?.();

  return new Promise<PickOneResult<T>>((resolve, reject) => {
    let settled = false;
    // Guard against re-entrancy inside the 'c' custom-value branch, which
    // temporarily leaves raw mode and uses readline; if a stray keypress
    // fires in the interim it must not reach processKey.
    let busy = false;

    const teardown = (): void => {
      input.off('keypress', onKeypress);
      try { input.setRawMode?.(false); } catch { /* ignore */ }
      (input as { pause?: () => void }).pause?.();
    };

    const done = (value: PickOneResult<T>): void => {
      if (settled) return;
      settled = true;
      teardown();
      resolve(value);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      teardown();
      reject(err);
    };

    const onKeypress = (str: string | undefined, key: KeypressKey | undefined): void => {
      if (settled || busy) return;
      // key is usually defined; str fallback for plain chars when parser
      // didn't recognise the byte (e.g. some combining marks).
      const name = key?.name;
      const ctrl = key?.ctrl === true;
      const sequence = key?.sequence ?? str ?? '';

      // Ctrl-C
      if (ctrl && name === 'c') {
        if (allowSkip) { done('skip'); return; }
        done(items[defaultIdx]!.value);
        return;
      }

      // Arrow navigation
      if (name === 'up') {
        if (cursor > 0) {
          cursor--;
          unrender();
          render();
        }
        return;
      }
      if (name === 'down') {
        if (cursor < items.length - 1) {
          cursor++;
          unrender();
          render();
        }
        return;
      }

      // Enter / Return
      if (name === 'return' || name === 'enter') {
        unrender();
        done(items[cursor]!.value);
        return;
      }

      // Single printable char — shortcut / skip / custom
      // Skip if modifier held (ctrl/meta) or name is a control key.
      if (!ctrl && !key?.meta && sequence.length === 1) {
        const ch = sequence;
        const lc = ch.toLowerCase();
        if ((lc === 's') && allowSkip) {
          unrender();
          done('skip');
          return;
        }
        if ((lc === 'c') && allowCustom) {
          busy = true;
          unrender();
          // Leave raw mode + drop our listener so readline's interface can
          // cleanly read a cooked-mode line. We'll reinstate nothing — the
          // custom branch terminates the picker either way.
          input.off('keypress', onKeypress);
          try { input.setRawMode?.(false); } catch { /* ignore */ }
          output.write('  Custom value: ');
          readLine(input, output)
            .then((custom) => {
              if (settled) return;
              settled = true;
              // no raw-mode to restore; teardown's setRawMode(false) is a
              // no-op, but still pause for symmetry.
              (input as { pause?: () => void }).pause?.();
              resolve({ custom: custom.trim() });
            })
            .catch((err: Error) => {
              if (settled) return;
              settled = true;
              (input as { pause?: () => void }).pause?.();
              reject(err);
            });
          return;
        }
        if (Object.prototype.hasOwnProperty.call(shortcuts, lc)) {
          const idx = shortcuts[lc]!;
          if (idx >= 0 && idx < items.length) {
            unrender();
            done(items[idx]!.value);
            return;
          }
        }
      }

      // Unknown key → ignore (stray bytes from prior REPL line, UTF-8
      // combining marks, function keys, etc. must not fire actions).
      void sequence;
      void fail;
    };

    input.on('keypress', onKeypress);
  });
}

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

// Exported for tests — kept as a hook so tests can still feed synthetic
// keystrokes through the public `pickOne`/`confirmPick` API.
export const __testing = {};
