import { describe, expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { confirm, __testing } from '../../../src/channels/cli/confirm.ts';
import { ErrorCode, NimbusError } from '../../../src/observability/errors.ts';

function makeIO(answer: string): { input: Readable; output: Writable; captured: { text: string } } {
  const captured = { text: '' };
  const input = new Readable({ read() {} });
  const output = new Writable({
    write(chunk, _enc, cb) {
      captured.text += chunk.toString();
      cb();
    },
  });
  // emit answer immediately after consumer attaches
  setImmediate(() => {
    input.push(`${answer}\n`);
    input.push(null);
  });
  return { input, output, captured };
}

describe('SPEC-801: confirm prompt', () => {
  test('"y" resolves true', async () => {
    const { input, output } = makeIO('y');
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(true);
  });

  test('"yes" resolves true', async () => {
    const { input, output } = makeIO('yes');
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(true);
  });

  test('empty (Enter) with defaultNo=true resolves false', async () => {
    const { input, output } = makeIO('');
    const ok = await confirm('go?', { input, output, defaultNo: true, timeoutMs: 5000 });
    expect(ok).toBe(false);
  });

  test('"n" resolves false', async () => {
    const { input, output } = makeIO('n');
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(false);
  });

  test('timeout resolves false', async () => {
    const input = new Readable({ read() {} });
    const output = new Writable({ write(_c, _e, cb) { cb(); } });
    const ok = await confirm('go?', { input, output, timeoutMs: 20 });
    expect(ok).toBe(false);
  });

  test('parseAnswer helper', () => {
    expect(__testing.strictAnswer('y', true)).toBe(true);
    expect(__testing.strictAnswer('', true)).toBe(false);
    expect(__testing.strictAnswer('', false)).toBe(true);
    expect(__testing.strictAnswer('no', false)).toBe(false);
  });
});
