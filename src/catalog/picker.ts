// SPEC-903 T7 — readline picker: ↑↓ navigate, Enter select, `c` custom, `s` skip.
// Falls through to free-text entry when model list is empty or TTY unavailable.
import type { ModelDescriptor } from './types.ts';

export interface PickerIO {
  input?: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface PickerOptions {
  prompt?: string;
  /** show a banner before the list (e.g. "using curated list, may be stale") */
  banner?: string;
  io?: PickerIO;
}

export type PickerResult =
  | { kind: 'selected'; id: string; descriptor: ModelDescriptor }
  | { kind: 'custom'; id: string }
  | { kind: 'skipped' };

const CTRL_C = '\u0003';
const ESC = '\u001b';
const ARROW_UP = `${ESC}[A`;
const ARROW_DOWN = `${ESC}[B`;
const CR = '\r';
const LF = '\n';

export async function pickModel(
  models: ModelDescriptor[],
  opts: PickerOptions = {},
): Promise<PickerResult> {
  const input = opts.io?.input ?? process.stdin;
  const output = opts.io?.output ?? process.stdout;
  const write = (s: string): void => {
    output.write(s);
  };
  const prompt = opts.prompt ?? 'Select model';
  if (opts.banner) write(`\n  [MODELS] ${opts.banner}\n`);

  // Empty list — ask for free text or allow skip.
  if (models.length === 0) {
    write(`\n  ${prompt}: no models fetched. Press Enter for custom, 's' to skip.\n`);
    const raw = await readLine(input, output);
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === 'c') {
      const id = await promptCustom(input, output);
      return id.length === 0 ? { kind: 'skipped' } : { kind: 'custom', id };
    }
    if (trimmed === 's') return { kind: 'skipped' };
    return { kind: 'custom', id: trimmed };
  }

  // Non-TTY fallback: just echo list, read line. Enter accepts first, `s` skips.
  const rawCapable = typeof input.setRawMode === 'function' && input.isTTY === true;
  if (!rawCapable) {
    write(`\n  ${prompt}:\n`);
    models.slice(0, 25).forEach((m, i) => {
      write(`    ${i + 1}. ${formatEntry(m)}\n`);
    });
    write(`  Enter number (1-${Math.min(models.length, 25)}), 'c' custom, 's' skip [1]: `);
    const raw = (await readLine(input, output)).trim();
    if (raw === 's') return { kind: 'skipped' };
    if (raw === 'c') {
      const id = await promptCustom(input, output);
      return id.length === 0 ? { kind: 'skipped' } : { kind: 'custom', id };
    }
    const idx = raw === '' ? 0 : parseInt(raw, 10) - 1;
    if (Number.isFinite(idx) && idx >= 0 && idx < models.length) {
      const chosen = models[idx]!;
      return { kind: 'selected', id: chosen.id, descriptor: chosen };
    }
    return { kind: 'custom', id: raw };
  }

  // Raw mode TTY picker.
  return rawModePicker(models, prompt, input, output, write);
}

async function rawModePicker(
  models: ModelDescriptor[],
  prompt: string,
  input: NonNullable<PickerIO['input']>,
  _output: NonNullable<PickerIO['output']>,
  write: (s: string) => void,
): Promise<PickerResult> {
  const pageSize = 10;
  let cursor = 0;
  let top = 0;
  const max = Math.min(models.length, 25);

  write(`\n  ${prompt} — ↑↓ navigate, Enter select, 'c' custom, 's' skip\n`);
  const render = (): void => {
    for (let i = top; i < Math.min(top + pageSize, max); i++) {
      const mark = i === cursor ? '> ' : '  ';
      const m = models[i]!;
      write(`  ${mark}${formatEntry(m)}\n`);
    }
  };
  const unrender = (): void => {
    const lines = Math.min(pageSize, max - top);
    for (let i = 0; i < lines; i++) write('\u001b[1A\u001b[2K');
  };

  render();
  input.setRawMode?.(true);
  input.resume?.();

  try {
    for (;;) {
      const key = await readKey(input);
      if (key === CTRL_C) return { kind: 'skipped' };
      if (key === 's' || key === 'S') return { kind: 'skipped' };
      if (key === 'c' || key === 'C') {
        unrender();
        input.setRawMode?.(false);
        const id = await promptCustom(input, _output);
        return id.length === 0 ? { kind: 'skipped' } : { kind: 'custom', id };
      }
      if (key === CR || key === LF) {
        const chosen = models[cursor]!;
        return { kind: 'selected', id: chosen.id, descriptor: chosen };
      }
      let moved = false;
      if (key === ARROW_UP && cursor > 0) {
        cursor--;
        moved = true;
      } else if (key === ARROW_DOWN && cursor < max - 1) {
        cursor++;
        moved = true;
      }
      if (moved) {
        if (cursor < top) top = cursor;
        else if (cursor >= top + pageSize) top = cursor - pageSize + 1;
        unrender();
        render();
      }
    }
  } finally {
    input.setRawMode?.(false);
    input.pause?.();
  }
}

export function formatEntry(m: ModelDescriptor): string {
  const klass = m.classHint ? ` [${m.classHint}]` : '';
  const ctx = m.contextLength ? ` ${Math.round(m.contextLength / 1000)}k` : '';
  return `${m.id}${klass}${ctx}`;
}

async function readKey(stream: NonNullable<PickerIO['input']>): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      stream.off('data', onData);
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      resolve(s);
    };
    stream.on('data', onData);
  });
}

async function readLine(
  input: NonNullable<PickerIO['input']>,
  output: NonNullable<PickerIO['output']>,
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

async function promptCustom(
  input: NonNullable<PickerIO['input']>,
  output: NonNullable<PickerIO['output']>,
): Promise<string> {
  output.write('  Custom model id: ');
  const raw = await readLine(input, output);
  return raw.trim();
}
