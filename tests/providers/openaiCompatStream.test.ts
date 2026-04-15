import { describe, expect, test } from 'bun:test';
import type { CanonicalChunk, CanonicalRequest } from '../../src/ir/types';
import { streamOpenAICompat } from '../../src/providers/openaiCompat';

// Minimal mock of OpenAI client that returns a prebuilt chunk stream.
function mockClient(chunks: unknown[]): { chat: { completions: { create: (p: unknown, o: unknown) => Promise<AsyncIterable<unknown>> } } } {
  return {
    chat: {
      completions: {
        create: async () => {
          async function* gen(): AsyncIterable<unknown> {
            for (const c of chunks) yield c;
          }
          return gen();
        },
      },
    },
  };
}

function deltaChunk(toolCall: {
  index: number;
  id?: string;
  name?: string;
  args?: string;
  role?: 'assistant';
}): unknown {
  const tc: Record<string, unknown> = { index: toolCall.index };
  if (toolCall.id) tc.id = toolCall.id;
  if (toolCall.id) tc.type = 'function';
  const fn: Record<string, unknown> = {};
  if (toolCall.name !== undefined) fn.name = toolCall.name;
  if (toolCall.args !== undefined) fn.arguments = toolCall.args;
  tc.function = fn;
  const delta: Record<string, unknown> = { tool_calls: [tc] };
  if (toolCall.role) delta.role = toolCall.role;
  return {
    id: 'chatcmpl-1',
    model: 'gpt-4o',
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

function finishChunk(): unknown {
  return {
    id: 'chatcmpl-1',
    model: 'gpt-4o',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  };
}

async function collect(chunks: unknown[]): Promise<CanonicalChunk[]> {
  const req: CanonicalRequest = {
    model: 'gpt-4o',
    stream: true,
    messages: [{ role: 'user', content: 'x' }],
  };
  const client = mockClient(chunks) as unknown as Parameters<typeof streamOpenAICompat>[0]['client'];
  const out: CanonicalChunk[] = [];
  for await (const c of streamOpenAICompat({
    client,
    req,
    signal: new AbortController().signal,
  })) {
    out.push(c);
  }
  return out;
}

describe('SPEC-203: streamOpenAICompat tool-call delta accumulator', () => {
  test('accumulates partial JSON across 2 deltas into one parsed tool_use', async () => {
    const out = await collect([
      deltaChunk({ index: 0, id: 'call_1', name: 'bash', args: '', role: 'assistant' }),
      deltaChunk({ index: 0, args: '{"cmd":' }),
      deltaChunk({ index: 0, args: '"ls"}' }),
      finishChunk(),
      {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
    ]);

    // No error chunks during delta accumulation (the original QA bug).
    expect(out.filter((c) => c.type === 'error')).toHaveLength(0);

    const start = out.find((c) => c.type === 'content_block_start');
    expect(start).toBeDefined();
    if (start && start.type === 'content_block_start' && start.block.type === 'tool_use') {
      expect(start.block.id).toBe('call_1');
      expect(start.block.name).toBe('bash');
      expect(start.block.input).toEqual({ cmd: 'ls' });
    }

    const stop = out.find((c) => c.type === 'message_stop');
    expect(stop).toBeDefined();
    if (stop && stop.type === 'message_stop') expect(stop.finishReason).toBe('tool_use');

    const usage = out.find((c) => c.type === 'usage');
    expect(usage).toBeDefined();
    if (usage && usage.type === 'usage') expect(usage.cacheRead).toBe(3);
  });

  test('QA reproduce: char-by-char streamed args `{"pa` / `th":"` / `README.md"}`', async () => {
    // Worst-case partial JSON fragments that individually fail JSON.parse.
    const fragments = ['{"pa', 'th":"', 'READ', 'ME.md"}'];
    const chunks: unknown[] = [
      deltaChunk({
        index: 0,
        id: 'call_read',
        name: 'Read',
        args: '',
        role: 'assistant',
      }),
      ...fragments.map((f) => deltaChunk({ index: 0, args: f })),
      finishChunk(),
    ];

    const out = await collect(chunks);

    expect(out.filter((c) => c.type === 'error')).toHaveLength(0);
    const start = out.find((c) => c.type === 'content_block_start');
    expect(start).toBeDefined();
    if (start && start.type === 'content_block_start' && start.block.type === 'tool_use') {
      expect(start.block.input).toEqual({ path: 'README.md' });
    }
  });

  test('split tool name across deltas is concatenated', async () => {
    const out = await collect([
      deltaChunk({ index: 0, id: 'call_1', name: 'ba', role: 'assistant' }),
      deltaChunk({ index: 0, name: 'sh' }),
      deltaChunk({ index: 0, args: '{"cmd":"pwd"}' }),
      finishChunk(),
    ]);
    const start = out.find((c) => c.type === 'content_block_start');
    expect(start).toBeDefined();
    if (start && start.type === 'content_block_start' && start.block.type === 'tool_use') {
      expect(start.block.name).toBe('bash');
    }
  });

  test('parallel tool_calls by different indices both emitted', async () => {
    const out = await collect([
      deltaChunk({ index: 0, id: 'c1', name: 'a', role: 'assistant' }),
      deltaChunk({ index: 1, id: 'c2', name: 'b' }),
      deltaChunk({ index: 0, args: '{"x":1}' }),
      deltaChunk({ index: 1, args: '{"y":2}' }),
      finishChunk(),
    ]);
    const starts = out.filter((c) => c.type === 'content_block_start');
    expect(starts).toHaveLength(2);
  });

  test('empty args string parsed as empty object (tool with no params)', async () => {
    const out = await collect([
      deltaChunk({ index: 0, id: 'c1', name: 'noop', role: 'assistant' }),
      finishChunk(),
    ]);
    const start = out.find((c) => c.type === 'content_block_start');
    expect(start).toBeDefined();
    if (start && start.type === 'content_block_start' && start.block.type === 'tool_use') {
      expect(start.block.input).toEqual({});
    }
  });

  test('malformed JSON at finish: emits error chunk, message_stop still yielded', async () => {
    const out = await collect([
      deltaChunk({ index: 0, id: 'c1', name: 'x', args: '{not-json', role: 'assistant' }),
      finishChunk(),
    ]);
    const err = out.find((c) => c.type === 'error');
    expect(err).toBeDefined();
    const stop = out.find((c) => c.type === 'message_stop');
    expect(stop).toBeDefined();
    // No content_block_start for the broken tool call.
    expect(out.filter((c) => c.type === 'content_block_start')).toHaveLength(0);
  });

  test('text-only response: no tool_use block, no parse attempted', async () => {
    const out = await collect([
      {
        id: 'c1',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'c1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
      },
      {
        id: 'c1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]);
    expect(out.filter((c) => c.type === 'error')).toHaveLength(0);
    const deltas = out.filter(
      (c) => c.type === 'content_block_delta',
    );
    expect(deltas.length).toBeGreaterThan(0);
  });
});
