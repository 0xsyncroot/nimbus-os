// sanitizePriorMessages.test.ts — v0.3.16 regression suite for the
// orphan tool_use → provider 400 repair path.
//
// Root cause recap (v0.3.16): Anthropic + OpenAI reject any request where an
// assistant `tool_use` block has no matching `tool_result`. The REPL can
// persist an orphan if the process is killed between
//   appendMessage(assistant-with-tool_use)  [loop.ts ~300]
// and
//   appendMessage(user-with-tool_result)    [loop.ts ~519].
// Before v0.3.16 that orphan replayed on every subsequent turn, hitting
// `P_INVALID_REQUEST {status:400}` — the exact symptom user reported on
// v0.3.15 when a prior v0.3.14 picker-bug session had aborted mid-tool.

import { describe, test, expect } from 'bun:test';
import { sanitizePriorMessages } from '../../src/core/loop.ts';
import type { CanonicalMessage } from '../../src/ir/types.ts';

describe('sanitizePriorMessages — orphan tool_use repair', () => {
  test('passes through empty history unchanged', () => {
    expect(sanitizePriorMessages([])).toEqual([]);
  });

  test('preserves a fully-paired history verbatim', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure, listing files' },
          { type: 'tool_use', id: 'toolu_A', name: 'Ls', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_A',
            content: 'a.ts\nb.ts',
            isError: false,
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const out = sanitizePriorMessages(msgs);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual(msgs[0]!);
    expect(out[1]).toEqual(msgs[1]!);
    expect(out[2]).toEqual(msgs[2]!);
    expect(out[3]).toEqual(msgs[3]!);
  });

  test('repairs an orphan tool_use at the end of history', () => {
    // Session JSONL looked like: user text → assistant tool_use → [crash]
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'list files' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_A', name: 'Ls', input: {} }],
      },
    ];
    const out = sanitizePriorMessages(msgs);
    expect(out).toHaveLength(3);
    expect(out[2]!.role).toBe('user');
    const blocks = out[2]!.content;
    expect(Array.isArray(blocks)).toBe(true);
    const stub = Array.isArray(blocks) ? blocks[0]! : null;
    expect(stub).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_A',
      isError: true,
    });
  });

  test('repairs an orphan tool_use in the MIDDLE of history', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_A', name: 'Ls', input: {} }],
      },
      // ↑ orphan (no tool_result)
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ];
    const out = sanitizePriorMessages(msgs);
    // Expect: user q1, assistant tool_use, SYNTHETIC user tool_result, user q2, assistant text
    expect(out).toHaveLength(5);
    expect(out[2]!.role).toBe('user');
    const firstContent = out[2]!.content;
    expect(Array.isArray(firstContent) ? firstContent[0] : null).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_A',
    });
    // downstream untouched
    expect(out[3]).toEqual(msgs[2]!);
    expect(out[4]).toEqual(msgs[3]!);
  });

  test('repairs multiple parallel orphans in the same assistant turn', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'read two files' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_A', name: 'Read', input: { p: 'a' } },
          { type: 'tool_use', id: 'toolu_B', name: 'Read', input: { p: 'b' } },
        ],
      },
    ];
    const out = sanitizePriorMessages(msgs);
    expect(out).toHaveLength(3);
    const stubContent = out[2]!.content;
    expect(Array.isArray(stubContent)).toBe(true);
    if (Array.isArray(stubContent)) {
      expect(stubContent).toHaveLength(2);
      const ids = stubContent.map((b) => (b as { toolUseId?: string }).toolUseId).sort();
      expect(ids).toEqual(['toolu_A', 'toolu_B']);
    }
  });

  test('drops orphan tool_result (no matching tool_use upstream)', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_stale',
            content: 'leftover',
            isError: false,
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ];
    const out = sanitizePriorMessages(msgs);
    // middle user message should be dropped entirely (content became empty)
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(msgs[0]!);
    expect(out[1]).toEqual(msgs[2]!);
  });

  test('handles partial pairing — some tool_use matched, others orphaned', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'do two tools' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_A', name: 'Ls', input: {} },
          { type: 'tool_use', id: 'toolu_B', name: 'Read', input: { p: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_A',
            content: 'ok',
            isError: false,
          },
          // toolu_B is missing — crash between the two result blocks.
        ],
      },
    ];
    const out = sanitizePriorMessages(msgs);
    // Preferred behaviour: merge synthetic stubs INTO the adjacent user
    // tool_result message so the pair stays in the same turn (provider
    // expects tool_use and tool_result in back-to-back messages).
    expect(out).toHaveLength(3);
    const userMsg = out[2]!;
    expect(userMsg.role).toBe('user');
    const blocks = userMsg.content;
    expect(Array.isArray(blocks)).toBe(true);
    if (Array.isArray(blocks)) {
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'toolu_A',
        isError: false,
      });
      expect(blocks[1]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'toolu_B',
        isError: true,
      });
    }
  });

  test('is idempotent — running twice yields the same result', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'list' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_X', name: 'Ls', input: {} }],
      },
    ];
    const once = sanitizePriorMessages(msgs);
    const twice = sanitizePriorMessages(once);
    expect(twice).toEqual(once);
  });

  test('never mutates the input array', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_Y', name: 'Ls', input: {} }],
      },
    ];
    const snapshot = JSON.stringify(msgs);
    sanitizePriorMessages(msgs);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  test('drops empty assistant messages (provider rejects empty content)', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ];
    const out = sanitizePriorMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual(msgs[2]!);
  });
});
