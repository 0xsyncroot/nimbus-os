import { describe, expect, test } from 'bun:test';
import type { CanonicalBlock, CanonicalMessage } from '../../src/ir/types';
import {
  countTokensApprox,
  extractText,
  isText,
  isThinking,
  isToolResult,
  isToolUse,
  mergeAdjacentText,
  newToolUseId,
  splitByType,
} from '../../src/ir/helpers';

describe('SPEC-201: IR helpers', () => {
  describe('extractText', () => {
    test('returns content when string', () => {
      expect(extractText({ role: 'user', content: 'hello' })).toBe('hello');
    });

    test('returns "" when content has no text blocks', () => {
      const msg: CanonicalMessage = {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }],
      };
      expect(extractText(msg)).toBe('');
    });

    test('concatenates text blocks, ignores non-text', () => {
      const msg: CanonicalMessage = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'thinking', text: 'secret' },
          { type: 'text', text: 'world' },
        ],
      };
      expect(extractText(msg)).toBe('hello world');
    });
  });

  describe('mergeAdjacentText', () => {
    test('merges adjacent text blocks', () => {
      const blocks: CanonicalBlock[] = [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
        { type: 'tool_use', id: '1', name: 'x', input: {} },
        { type: 'text', text: 'c' },
      ];
      const out = mergeAdjacentText(blocks);
      expect(out).toHaveLength(3);
      expect(out[0]).toEqual({ type: 'text', text: 'ab' });
    });

    test('preserves cacheHint from last of run', () => {
      const blocks: CanonicalBlock[] = [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b', cacheHint: 'ephemeral' },
      ];
      const out = mergeAdjacentText(blocks);
      expect(out[0]).toEqual({ type: 'text', text: 'ab', cacheHint: 'ephemeral' });
    });
  });

  describe('splitByType', () => {
    test('filters by discriminant and narrows type', () => {
      const blocks: CanonicalBlock[] = [
        { type: 'text', text: 'a' },
        { type: 'tool_use', id: '1', name: 'x', input: {} },
        { type: 'tool_use', id: '2', name: 'y', input: { k: 1 } },
      ];
      const uses = splitByType(blocks, 'tool_use');
      expect(uses).toHaveLength(2);
      expect(uses[0]!.id).toBe('1');
    });
  });

  describe('type guards', () => {
    test('isToolUse/isToolResult/isText/isThinking narrow correctly', () => {
      const tu: CanonicalBlock = { type: 'tool_use', id: '1', name: 'x', input: {} };
      const tr: CanonicalBlock = { type: 'tool_result', toolUseId: '1', content: 'ok' };
      const t: CanonicalBlock = { type: 'text', text: 'x' };
      const th: CanonicalBlock = { type: 'thinking', text: 'x' };
      expect(isToolUse(tu)).toBe(true);
      expect(isToolResult(tr)).toBe(true);
      expect(isText(t)).toBe(true);
      expect(isThinking(th)).toBe(true);
      expect(isToolUse(t)).toBe(false);
    });
  });

  describe('newToolUseId', () => {
    test('returns ULID string 26 chars Crockford base32', () => {
      const id = newToolUseId();
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    test('time prefix (first 10 chars) sorts monotonically across calls', async () => {
      const a = newToolUseId();
      await new Promise((r) => setTimeout(r, 2));
      const b = newToolUseId();
      expect(a.slice(0, 10).localeCompare(b.slice(0, 10))).toBeLessThanOrEqual(0);
    });
  });

  describe('countTokensApprox', () => {
    test('rough char/4 count over text + tool blocks', () => {
      const msgs: CanonicalMessage[] = [
        { role: 'user', content: 'abcd' }, // 4 chars → 1 token
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello world' }, // 11
            { type: 'tool_use', id: '1', name: 'bash', input: { cmd: 'ls' } },
          ],
        },
      ];
      expect(countTokensApprox(msgs)).toBeGreaterThan(0);
    });
  });

  describe('perf', () => {
    test('extractText on 100-block message completes well under 10ms', () => {
      const content: CanonicalBlock[] = Array.from({ length: 100 }, (_, i) => ({
        type: 'text' as const,
        text: `block ${i} `,
      }));
      const msg: CanonicalMessage = { role: 'assistant', content };
      const t0 = performance.now();
      const out = extractText(msg);
      const t1 = performance.now();
      expect(out.length).toBeGreaterThan(0);
      expect(t1 - t0).toBeLessThan(10);
    });
  });
});
