// picker.ts — SPEC-901 v0.3.15: generic TTY picker for init wizard + tool-confirm.
//
// v0.3.15 URGENT (fifth regression on same picker): the prior rewrite (v0.3.14)
// using readline.emitKeypressEvents solved chunk-split ANSI parsing but did
// NOT solve the "ghost keypress on picker open" bug the user keeps hitting:
// the picker attaches its keypress listener and IMMEDIATELY receives a
// synthetic `return`/`down` event that the user never typed, resolving the
// picker before render even finishes.
//
// Root cause (confirmed by PTY trace in scripts/pty-smoke/repl-repro.ts):
//
//   1. Autocomplete consumes user's `\r` and resolves its readLine promise.
//   2. Cleanup calls `setRawMode(false)` + removeListener('data', onData).
//   3. Between REPL turns, stdin is still attached to the Node/Bun stream
//      machinery. Any byte that arrives while no raw-mode reader is active
//      — including bytes already in-flight in Node's internal buffer when
//      the prior listener was removed — sits in the stream's readable queue.
//   4. Picker opens: `readline.emitKeypressEvents(input)` installs/reuses
//      the keypress decoder, `setRawMode(true)` + `resume()` flushes the
//      queued bytes into the decoder, which emits `keypress` to the listener
//      we just attached. First event the user sees is phantom.
//
// The previous five attempts (v0.3.10–v0.3.14) tried to fix this by rewriting
// the byte parser. That's the wrong layer — the parser was never wrong. The
// bug is input bytes bleeding across the autocomplete→picker handoff.
//
// Fix strategy (defense-in-depth):
//
//  A. DRAIN stdin BEFORE attaching the picker listener. `stream.read()` on a
//     paused readable returns any bytes already queued internally, which we
//     discard. Runs inside a setImmediate tick so Node's internal buffer has
//     settled after the prior listener's removal.
//
//  B. PRIMING WINDOW: for the first ~80ms after attach, silently swallow any
//     keypress. No human can react from "picker render finished" to a key
//     press in <200ms (human reaction time baseline). Any key arriving in
//     80ms is necessarily a buffered / replayed / cross-turn leftover, NEVER
//     a legitimate user response. This is the same pattern used by
//     enquirer/inquirer's internal `_isKeypress` gate.
//
//  C. PARSER UNCHANGED: still use readline.emitKeypressEvents (industry
//     standard, handles ANSI+UTF-8 correctly). No more rolling our own.
//
// History of failures:
//  * v0.3.10 double echo "yy" — handler attached before setRawMode(true).
//  * v0.3.11 autocomplete cleanup racing rawMode acquisition.
//  * v0.3.12 shortcut fired on stray buffered byte from prior REPL line.
//  * v0.3.13 parseKeys emitted wrong keys for chunk-split ANSI sequences.
//  * v0.3.14 emitKeypressEvents fixed parsing but byte-bleed into new
//    listener still caused phantom Enter/Down on picker open.

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

/** Priming window — silently drop keypresses that arrive in the first
 *  PRIMING_WINDOW_MS after the listener attaches. See file header.
 *  Configurable via NIMBUS_PICKER_PRIMING_MS for tests; default 80ms. */
const DEFAULT_PRIMING_WINDOW_MS = 80;

/** Four-way confirm picker used for tool-permission prompts. */
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

/** Drain any bytes already queued inside Node's readable stream state.
 *  Safe to call whether the stream is paused or flowing; `read()` returns
 *  null when empty. Called BEFORE attaching our listener so those bytes
 *  can never reach us as keypress events.
 *
 *  Explanation: between REPL turns, bytes arrive on stdin while no reader
 *  is attached. Node buffers them inside the readable stream's internal
 *  state (stream._readableState.buffer). `stream.read()` pulls from that
 *  buffer. We loop until empty to evict the carry-over. */
function drainStdin(input: NodeJS.ReadableStream): number {
  let bytesDrained = 0;
  const readable = input as unknown as { read: (n?: number) => unknown; readableLength?: number };
  if (typeof readable.read !== 'function') return 0;
  // Cap drain to 64KB — a legitimate buffered user line is at most a
  // few hundred bytes; anything larger is a programming error, not
  // user input.
  const MAX_DRAIN_BYTES = 64 * 1024;
  for (let i = 0; i < 128 && bytesDrained < MAX_DRAIN_BYTES; i++) {
    const chunk = readable.read();
    if (chunk === null || chunk === undefined) break;
    if (typeof chunk === 'string') {
      bytesDrained += Buffer.byteLength(chunk, 'utf8');
    } else if (chunk instanceof Uint8Array) {
      bytesDrained += chunk.length;
    } else if (typeof (chunk as { length?: number }).length === 'number') {
      bytesDrained += (chunk as { length: number }).length;
    }
  }
  return bytesDrained;
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

  // (A) Drain stdin queue BEFORE attaching the picker listener.
  // Any bytes sitting in Node's readable buffer from the prior REPL turn
  // would otherwise flush into the keypress decoder the moment we attach.
  const drainedBefore = drainStdin(input);

  // Install the keypress decoder. `emitKeypressEvents` is idempotent — safe
  // when `createInterface({terminal:true})` or a prior pickOne already set
  // it up on this stream.
  readline.emitKeypressEvents(input);
  input.setRawMode?.(true);
  (input as { resume?: () => void }).resume?.();

  // Second drain AFTER setRawMode(true)+resume — toggling raw mode on a
  // pseudo-terminal can cause the kernel line-discipline to release
  // previously-buffered bytes into the Node stream, and resume() triggers
  // a flow-start that delivers them. Draining again catches those.
  const drainedAfter = drainStdin(input);

  if (process.env['NIMBUS_PICKER_TRACE'] === '1') {
    process.stderr.write(`[picker-trace] drained before=${drainedBefore}B after=${drainedAfter}B\n`);
  }

  const primingMs = Number(process.env['NIMBUS_PICKER_PRIMING_MS'] ?? DEFAULT_PRIMING_WINDOW_MS);
  const primingEndAt = Date.now() + primingMs;

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
      const name = key?.name;
      const ctrl = key?.ctrl === true;
      const sequence = key?.sequence ?? str ?? '';

      // (B) Priming window: swallow any keypress in the first primingMs
      // after attach. These are either leftover bytes from a previous REPL
      // line that bled through the autocomplete→picker handoff, or bytes
      // flushed by setRawMode(true)/resume() after a mode-toggle. No human
      // response can legitimately arrive this fast — typical keyboard
      // reaction time is ~250ms — so this window is imperceptible to real
      // users but conclusive against phantom events.
      const now = Date.now();
      if (now < primingEndAt) {
        if (process.env['NIMBUS_PICKER_TRACE'] === '1') {
          const bytes = Buffer.from(sequence, 'utf8').toString('hex');
          const remaining = primingEndAt - now;
          process.stderr.write(
            `[picker-trace] SWALLOWED (priming ${remaining}ms left) name=${name ?? '(unnamed)'} ctrl=${ctrl} seq_hex=${bytes}\n`,
          );
        }
        return;
      }

      if (process.env['NIMBUS_PICKER_TRACE'] === '1') {
        const bytes = Buffer.from(sequence, 'utf8').toString('hex');
        process.stderr.write(`[picker-trace] name=${name ?? '(unnamed)'} ctrl=${ctrl} seq_hex=${bytes} cursor=${cursor}\n`);
      }

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
          input.off('keypress', onKeypress);
          try { input.setRawMode?.(false); } catch { /* ignore */ }
          output.write('  Custom value: ');
          readLine(input, output)
            .then((custom) => {
              if (settled) return;
              settled = true;
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

      // Unknown key → ignore.
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

// Exported for tests.
export const __testing = { drainStdin, DEFAULT_PRIMING_WINDOW_MS };
