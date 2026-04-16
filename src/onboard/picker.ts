// picker.ts — SPEC-901 v0.2.1: generic TTY picker for init wizard.
// Extracted from src/catalog/picker.ts pattern — ↑↓ navigate, Enter select, 'c' custom, 's' skip.

export interface PickerItem<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface PickerOpts {
  default?: number;
  allowCustom?: boolean;
  allowSkip?: boolean;
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

  const rawCapable = typeof (input as { setRawMode?: unknown }).setRawMode === 'function'
    && (input as { isTTY?: boolean }).isTTY === true;

  if (!rawCapable) {
    return nonTtyPick(label, items, defaultIdx, allowCustom, allowSkip, input, output, write);
  }

  return rawModePick(label, items, defaultIdx, allowCustom, allowSkip, input, output, write);
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

  try {
    for (;;) {
      const key = await readKey(input);
      if (key === CTRL_C) {
        if (allowSkip) return 'skip';
        return items[defaultIdx]!.value;
      }
      if ((key === 's' || key === 'S') && allowSkip) {
        unrender();
        return 'skip';
      }
      if ((key === 'c' || key === 'C') && allowCustom) {
        unrender();
        input.setRawMode?.(false);
        output.write('  Custom value: ');
        const custom = (await readLine(input, output)).trim();
        return { custom };
      }
      if (key === CR || key === LF) {
        unrender();
        return items[cursor]!.value;
      }
      let moved = false;
      if (key === ARROW_UP && cursor > 0) { cursor--; moved = true; }
      else if (key === ARROW_DOWN && cursor < items.length - 1) { cursor++; moved = true; }
      if (moved) {
        // scroll when pageSize < items.length
        void pageSize; // used implicitly by cursor bounds
        unrender();
        render();
      }
    }
  } finally {
    input.setRawMode?.(false);
    (input as { pause?: () => void }).pause?.();
  }
}

async function readKey(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      stream.off('data', onData);
      resolve(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    };
    stream.on('data', onData);
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
