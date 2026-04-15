import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { pickModel, formatEntry } from '../../src/catalog/picker';
import type { ModelDescriptor } from '../../src/catalog/types';

function makeIO(answers: string[]): {
  input: PassThrough & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
  output: PassThrough & { isTTY?: boolean };
  captured: () => string;
} {
  const input = new PassThrough() as PassThrough & {
    setRawMode?: (raw: boolean) => unknown;
    isTTY?: boolean;
  };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  let out = '';
  output.on('data', (chunk: Buffer | string) => {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });
  // Feed answers as readline input (non-raw path).
  for (const a of answers) {
    input.write(`${a}\n`);
  }
  input.end();
  return { input, output, captured: () => out };
}

describe('SPEC-903: pickModel (non-TTY path)', () => {
  const models: ModelDescriptor[] = [
    { id: 'claude-opus-4-6', provider: 'anthropic', source: 'live' },
    { id: 'claude-sonnet-4-6', provider: 'anthropic', source: 'live' },
    { id: 'claude-haiku-4-5', provider: 'anthropic', source: 'live' },
  ];

  test('numeric selection returns correct descriptor', async () => {
    const { input, output } = makeIO(['2']);
    const res = await pickModel(models, { io: { input, output } });
    expect(res.kind).toBe('selected');
    if (res.kind === 'selected') {
      expect(res.id).toBe('claude-sonnet-4-6');
      expect(res.descriptor.provider).toBe('anthropic');
    }
  });

  test('Enter (empty) selects first', async () => {
    const { input, output } = makeIO(['']);
    const res = await pickModel(models, { io: { input, output } });
    expect(res.kind).toBe('selected');
    if (res.kind === 'selected') expect(res.id).toBe('claude-opus-4-6');
  });

  test('s skips', async () => {
    const { input, output } = makeIO(['s']);
    const res = await pickModel(models, { io: { input, output } });
    expect(res.kind).toBe('skipped');
  });

  test('c prompts custom id', async () => {
    const { input, output } = makeIO(['c', 'my-custom-model-id']);
    const res = await pickModel(models, { io: { input, output } });
    expect(res.kind).toBe('custom');
    if (res.kind === 'custom') expect(res.id).toBe('my-custom-model-id');
  });

  test('empty list: prompt for free text, Enter then non-empty → custom', async () => {
    const { input, output } = makeIO(['', 'custom-id']);
    const res = await pickModel([], { io: { input, output } });
    expect(res.kind).toBe('custom');
    if (res.kind === 'custom') expect(res.id).toBe('custom-id');
  });

  test('empty list: s → skipped', async () => {
    const { input, output } = makeIO(['s']);
    const res = await pickModel([], { io: { input, output } });
    expect(res.kind).toBe('skipped');
  });

  test('banner is printed', async () => {
    const { input, output, captured } = makeIO(['s']);
    await pickModel(models, {
      banner: 'using curated list, may be stale',
      io: { input, output },
    });
    expect(captured()).toContain('[MODELS] using curated list, may be stale');
  });

  test('invalid numeric entry → treated as custom', async () => {
    const { input, output } = makeIO(['99']);
    const res = await pickModel(models, { io: { input, output } });
    expect(res.kind).toBe('custom');
    if (res.kind === 'custom') expect(res.id).toBe('99');
  });
});

describe('SPEC-903: formatEntry', () => {
  test('includes classHint + context', () => {
    const s = formatEntry({
      id: 'gpt-4o',
      provider: 'openai',
      source: 'live',
      classHint: 'workhorse',
      contextLength: 128_000,
    });
    expect(s).toContain('gpt-4o');
    expect(s).toContain('[workhorse]');
    expect(s).toContain('128k');
  });

  test('minimal display', () => {
    const s = formatEntry({ id: 'x', provider: 'y', source: 'live' });
    expect(s).toBe('x');
  });
});
