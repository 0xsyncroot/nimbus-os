import { describe, expect, test } from 'bun:test';
import type { CanonicalBlock, CanonicalMessage } from '../../src/ir/types';
import {
  CanonicalBlockSchema,
  CanonicalMessageSchema,
} from '../../src/ir/schemas';

describe('SPEC-201: IR schemas', () => {
  test('rejects missing role', () => {
    expect(() =>
      CanonicalMessageSchema.parse({ content: 'hi' } as unknown),
    ).toThrow();
  });

  test('rejects unknown block type', () => {
    expect(() =>
      CanonicalBlockSchema.parse({ type: 'x', foo: 1 } as unknown),
    ).toThrow();
  });

  test('rejects extra keys (strict)', () => {
    expect(() =>
      CanonicalBlockSchema.parse({
        type: 'text',
        text: 'hi',
        extra: 1,
      } as unknown),
    ).toThrow();
  });

  test('round-trips every variant', () => {
    const variants: CanonicalBlock[] = [
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'hi', cacheHint: 'ephemeral' },
      { type: 'image', source: { kind: 'url', data: 'https://x/y.png', mimeType: 'image/png' } },
      { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
      { type: 'tool_result', toolUseId: 't1', content: 'ok' },
      { type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'ok' }], isError: false },
      { type: 'thinking', text: 'hmm', signature: 'sig' },
    ];
    for (const v of variants) {
      const parsed = CanonicalBlockSchema.parse(v);
      expect(parsed).toEqual(v);
    }
  });

  test('bounds tool_result nesting depth (DoS guard)', () => {
    const deep: CanonicalBlock = {
      type: 'tool_result',
      toolUseId: 't1',
      content: [
        {
          type: 'tool_result',
          toolUseId: 't2',
          content: [
            {
              type: 'tool_result',
              toolUseId: 't3',
              content: [
                {
                  type: 'tool_result',
                  toolUseId: 't4',
                  content: [{ type: 'text', text: 'too deep' }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => CanonicalBlockSchema.parse(deep)).toThrow();
  });

  test('accepts message with string content', () => {
    const msg: CanonicalMessage = { role: 'user', content: 'hi' };
    expect(CanonicalMessageSchema.parse(msg)).toEqual(msg);
  });
});
