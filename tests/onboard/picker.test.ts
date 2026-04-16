// picker.test.ts — SPEC-901 v0.2.1: tests for generic TTY picker
import { describe, expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { pickOne, type PickerItem } from '../../src/onboard/picker.ts';

const ESC = '\u001b';
const ARROW_UP = `${ESC}[A`;
const ARROW_DOWN = `${ESC}[B`;
const CR = '\r';
const CTRL_C = '\u0003';

function mockIO(keySequence: string[]): {
  input: Readable & { setRawMode: (raw: boolean) => unknown; isTTY: boolean; isRaw: boolean };
  output: Writable & { captured: string };
} {
  let idx = 0;
  const input = new Readable({
    read() {
      // Data pushed by sendKey()
    },
  }) as Readable & { setRawMode: (raw: boolean) => unknown; isTTY: boolean; isRaw: boolean };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw: boolean) => { input.isRaw = raw; return input; };

  // Push keys after a tick so the picker has time to set up listeners.
  let resolver: (() => void) | null = null;
  const scheduleNext = (): void => {
    setImmediate(() => {
      const key = keySequence[idx++];
      if (key !== undefined) {
        input.push(key);
        if (idx < keySequence.length) scheduleNext();
      }
    });
  };
  scheduleNext();
  void resolver;

  const output = new Writable({
    write(chunk, _enc, cb) {
      (output as Writable & { captured: string }).captured += chunk.toString();
      cb();
    },
  }) as Writable & { captured: string };
  output.captured = '';

  return { input, output };
}

function nonTtyIO(input: string): {
  input: Readable & { isTTY: boolean };
  output: Writable & { captured: string };
} {
  const readable = Readable.from([input]) as Readable & { isTTY: boolean };
  readable.isTTY = false;

  const output = new Writable({
    write(chunk, _enc, cb) {
      (output as Writable & { captured: string }).captured += chunk.toString();
      cb();
    },
  }) as Writable & { captured: string };
  output.captured = '';

  return { input: readable, output };
}

const FRUIT_ITEMS: PickerItem<string>[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
];

describe('SPEC-901 v0.2.1: pickOne (non-TTY fallback)', () => {
  test('Enter with empty input selects default (index 0)', async () => {
    const { input, output } = nonTtyIO('\n');
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 0 }, { input, output });
    expect(result).toBe('apple');
  });

  test('Number input selects correct item', async () => {
    const { input, output } = nonTtyIO('2\n');
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 0 }, { input, output });
    expect(result).toBe('banana');
  });

  test("'s' returns skip when allowSkip=true", async () => {
    const { input, output } = nonTtyIO('s\n');
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 0, allowSkip: true }, { input, output });
    expect(result).toBe('skip');
  });

  test("default index respected when different from 0", async () => {
    const { input, output } = nonTtyIO('\n');
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 1 }, { input, output });
    expect(result).toBe('banana');
  });

  test('out-of-range number falls back to default', async () => {
    const { input, output } = nonTtyIO('99\n');
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 0 }, { input, output });
    // parseInt('99')-1 = 98, out of bounds → default
    expect(result).toBe('apple');
  });
});

describe('SPEC-901 v0.2.1: pickOne (raw TTY)', () => {
  test('Enter selects current cursor (default 0)', async () => {
    const { input, output } = mockIO([CR]);
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 0 }, { input, output });
    expect(result).toBe('apple');
  });

  test('Arrow down then Enter selects next item', async () => {
    const { input, output } = mockIO([ARROW_DOWN, CR]);
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 0 }, { input, output });
    expect(result).toBe('banana');
  });

  test('Arrow down twice then Enter selects third item', async () => {
    const { input, output } = mockIO([ARROW_DOWN, ARROW_DOWN, CR]);
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 0 }, { input, output });
    expect(result).toBe('cherry');
  });

  test('Arrow up at top stays on first item', async () => {
    const { input, output } = mockIO([ARROW_UP, CR]);
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 0 }, { input, output });
    expect(result).toBe('apple');
  });

  test('Ctrl-C with allowSkip returns skip', async () => {
    const { input, output } = mockIO([CTRL_C]);
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 0, allowSkip: true }, { input, output });
    expect(result).toBe('skip');
  });

  test('Ctrl-C without allowSkip returns default', async () => {
    const { input, output } = mockIO([CTRL_C]);
    const result = await pickOne('Pick fruit', FRUIT_ITEMS, { default: 1 }, { input, output });
    expect(result).toBe('banana');
  });

  test('rendered output contains item labels', async () => {
    const { input, output } = mockIO([CR]);
    await pickOne('Pick fruit', FRUIT_ITEMS, { default: 0 }, { input, output });
    expect(output.captured).toContain('Apple');
    expect(output.captured).toContain('Banana');
  });
});
