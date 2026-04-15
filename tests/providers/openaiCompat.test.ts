import { describe, expect, test } from 'bun:test';
import { APIError } from 'openai';
import {
  classifyOpenAIError,
  ENDPOINTS,
  getEndpoint,
  getEndpointDynamic,
  toOpenAIMessages,
  toOpenAITools,
} from '../../src/providers/openaiCompat';
import type { CanonicalMessage } from '../../src/ir/types';
import { ErrorCode, NimbusError } from '../../src/observability/errors';

describe('SPEC-203: endpoints', () => {
  test('groq endpoint has correct baseUrl + capabilities', () => {
    const e = getEndpoint('groq');
    expect(e.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(e.capabilities.promptCaching).toBe('none');
    expect(e.capabilities.supportsParallelTools).toBe(true);
  });

  test('openai endpoint has implicit cache', () => {
    expect(ENDPOINTS.openai.capabilities.promptCaching).toBe('implicit');
  });

  test('ollama endpoint maps to localhost', () => {
    expect(ENDPOINTS.ollama.baseUrl).toBe('http://localhost:11434/v1');
  });

  test('deepseek endpoint has implicit cache', () => {
    expect(ENDPOINTS.deepseek.capabilities.promptCaching).toBe('implicit');
  });

  test('getEndpointDynamic throws on unknown', () => {
    try {
      getEndpointDynamic('unknown');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(NimbusError);
      expect((e as NimbusError).code).toBe(ErrorCode.U_MISSING_CONFIG);
    }
  });
});

describe('SPEC-203: toOpenAIMessages', () => {
  test('tool_result splits into separate role:tool message', () => {
    const msgs: CanonicalMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'pls run' },
          { type: 'tool_result', toolUseId: 'tu1', content: 'done' },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe('user');
    expect(out[1]!.role).toBe('tool');
    expect((out[1] as { tool_call_id: string }).tool_call_id).toBe('tu1');
  });

  test('strips thinking blocks, counts them in stats', () => {
    const stats = { stripped: 0 };
    const msgs: CanonicalMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'secret' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs, stats);
    expect(stats.stripped).toBe(1);
    expect(out).toHaveLength(1);
    expect((out[0] as { content: unknown }).content).toBe('answer');
  });

  test('image base64 → data URL', () => {
    const msgs: CanonicalMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { kind: 'base64', data: 'AAAA', mimeType: 'image/png' },
          },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs);
    const parts = (out[0] as { content: Array<{ type: string; image_url?: { url: string } }> })
      .content;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]!.type).toBe('image_url');
    expect(parts[0]!.image_url!.url).toBe('data:image/png;base64,AAAA');
  });

  test('cacheHint dropped silently (no cache_control)', () => {
    const msgs: CanonicalMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', cacheHint: 'ephemeral' }],
      },
    ];
    const out = toOpenAIMessages(msgs);
    expect(JSON.stringify(out)).not.toContain('cache_control');
    expect(JSON.stringify(out)).not.toContain('cacheHint');
  });

  test('tool_use → tool_calls[].function.arguments JSON-stringified', () => {
    const msgs: CanonicalMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'tu1', name: 'bash', input: { cmd: 'ls' } },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs);
    expect(out).toHaveLength(1);
    const ast = out[0] as {
      tool_calls: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    expect(ast.tool_calls).toHaveLength(1);
    expect(ast.tool_calls[0]!.id).toBe('tu1');
    expect(ast.tool_calls[0]!.function.name).toBe('bash');
    expect(JSON.parse(ast.tool_calls[0]!.function.arguments)).toEqual({ cmd: 'ls' });
  });

  test('toOpenAITools maps ToolDefinition to function schema', () => {
    const out = toOpenAITools([
      { name: 'bash', description: 'run shell', inputSchema: { type: 'object' } },
    ]);
    expect(out[0]!.type).toBe('function');
    expect(out[0]!.function.name).toBe('bash');
    expect(out[0]!.function.description).toBe('run shell');
  });
});

describe('SPEC-203: classifyOpenAIError', () => {
  function makeApiErr(status: number | undefined, msg = 'err'): APIError {
    return new APIError(status, { error: { message: msg } }, msg, {});
  }

  test('401 → P_AUTH', () => {
    expect(classifyOpenAIError(makeApiErr(401)).code).toBe(ErrorCode.P_AUTH);
  });

  test('429 → P_429', () => {
    expect(classifyOpenAIError(makeApiErr(429)).code).toBe(ErrorCode.P_429);
  });

  test('5xx → P_5XX', () => {
    expect(classifyOpenAIError(makeApiErr(502)).code).toBe(ErrorCode.P_5XX);
  });

  test('400 + context → P_CONTEXT_OVERFLOW', () => {
    expect(
      classifyOpenAIError(makeApiErr(400, 'context length exceeded')).code,
    ).toBe(ErrorCode.P_CONTEXT_OVERFLOW);
  });

  test('404 → P_MODEL_NOT_FOUND', () => {
    expect(classifyOpenAIError(makeApiErr(404)).code).toBe(ErrorCode.P_MODEL_NOT_FOUND);
  });

  test('undefined status → P_NETWORK', () => {
    expect(classifyOpenAIError(makeApiErr(undefined)).code).toBe(ErrorCode.P_NETWORK);
  });

  test('plain Error → P_NETWORK', () => {
    expect(classifyOpenAIError(new Error('ECONNREFUSED')).code).toBe(ErrorCode.P_NETWORK);
  });

  test('AbortError re-thrown', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(() => classifyOpenAIError(abort)).toThrow(abort);
  });
});
