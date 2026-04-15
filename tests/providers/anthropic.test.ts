import { describe, expect, test } from 'bun:test';
import { APIError } from '@anthropic-ai/sdk';
import type { CanonicalRequest } from '../../src/ir/types';
import {
  anthropicCapabilities,
  classifyAnthropicError,
  toAnthropicRequest,
} from '../../src/providers/anthropic';
import { ErrorCode, NimbusError } from '../../src/observability/errors';

describe('SPEC-202: anthropicCapabilities', () => {
  test('extendedThinking true for sonnet/opus, false for haiku', () => {
    expect(anthropicCapabilities('claude-3-5-sonnet-latest').extendedThinking).toBe(true);
    expect(anthropicCapabilities('claude-opus-4').extendedThinking).toBe(true);
    expect(anthropicCapabilities('claude-haiku-4').extendedThinking).toBe(false);
  });

  test('explicit cache + nativeTools', () => {
    const c = anthropicCapabilities('claude-haiku-4');
    expect(c.promptCaching).toBe('explicit');
    expect(c.nativeTools).toBe(true);
    expect(c.vision).toBe('both');
    expect(c.maxContextTokens).toBe(200_000);
  });
});

describe('SPEC-202: toAnthropicRequest', () => {
  test('maps cacheHint ephemeral → cache_control on text block', () => {
    const req: CanonicalRequest = {
      model: 'claude-haiku-4',
      stream: true,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello', cacheHint: 'ephemeral' }],
        },
      ],
    };
    const out = toAnthropicRequest(req);
    const content = out.messages[0]!.content as Array<{ type: string; cache_control?: unknown }>;
    expect(content[0]!.type).toBe('text');
    expect(content[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('tool_use round-trips id/name/input', () => {
    const req: CanonicalRequest = {
      model: 'm',
      stream: true,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: { cmd: 'ls' } }],
        },
      ],
    };
    const out = toAnthropicRequest(req);
    const b = (out.messages[0]!.content as Array<{
      type: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>)[0]!;
    expect(b.type).toBe('tool_use');
    expect(b.id).toBe('tu1');
    expect(b.name).toBe('bash');
    expect(b.input).toEqual({ cmd: 'ls' });
  });

  test('tool_result toolUseId → tool_use_id', () => {
    const req: CanonicalRequest = {
      model: 'm',
      stream: true,
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'ok' }],
        },
      ],
    };
    const out = toAnthropicRequest(req);
    const b = (out.messages[0]!.content as Array<{ tool_use_id?: string }>)[0]!;
    expect(b.tool_use_id).toBe('tu1');
  });

  test('system as text block array with cache_control', () => {
    const req: CanonicalRequest = {
      model: 'm',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      system: [
        { type: 'text', text: 'You are ...', cacheHint: 'ephemeral' },
        { type: 'text', text: 'Context' },
      ],
    };
    const out = toAnthropicRequest(req);
    const sys = out.system as Array<{ text: string; cache_control?: unknown }>;
    expect(sys).toHaveLength(2);
    expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[1]!.cache_control).toBeUndefined();
  });

  test('>4 cacheHint blocks: only 4 carry cache_control', () => {
    let overflowCount = 0;
    const blocks = Array.from({ length: 6 }, (_, i) => ({
      type: 'text' as const,
      text: `b${i}`,
      cacheHint: 'ephemeral' as const,
    }));
    const req: CanonicalRequest = {
      model: 'm',
      stream: true,
      messages: [{ role: 'user', content: blocks }],
    };
    const out = toAnthropicRequest(req, {
      capsExplicitCache: true,
      onCacheOverflow: (n) => {
        overflowCount = n;
      },
    });
    const content = out.messages[0]!.content as Array<{ cache_control?: unknown }>;
    const withCache = content.filter((b) => b.cache_control !== undefined);
    expect(withCache).toHaveLength(4);
    expect(overflowCount).toBe(2);
  });
});

describe('SPEC-202: classifyAnthropicError', () => {
  function makeApiErr(
    status: number | undefined,
    bodyType?: string,
  ): APIError {
    const err = new APIError(
      status,
      bodyType ? { error: { type: bodyType, message: 'x' } } : undefined,
      'anthropic err',
      {},
    );
    return err;
  }

  test('401/403 → P_AUTH', () => {
    expect(classifyAnthropicError(makeApiErr(401)).code).toBe(ErrorCode.P_AUTH);
    expect(classifyAnthropicError(makeApiErr(403)).code).toBe(ErrorCode.P_AUTH);
  });

  test('429 → P_429', () => {
    expect(classifyAnthropicError(makeApiErr(429)).code).toBe(ErrorCode.P_429);
  });

  test('5xx → P_5XX', () => {
    expect(classifyAnthropicError(makeApiErr(500)).code).toBe(ErrorCode.P_5XX);
    expect(classifyAnthropicError(makeApiErr(503)).code).toBe(ErrorCode.P_5XX);
  });

  test('400 + context_length_exceeded → P_CONTEXT_OVERFLOW', () => {
    expect(
      classifyAnthropicError(makeApiErr(400, 'context_length_exceeded')).code,
    ).toBe(ErrorCode.P_CONTEXT_OVERFLOW);
  });

  test('404 + not_found_error → P_MODEL_NOT_FOUND', () => {
    expect(
      classifyAnthropicError(makeApiErr(404, 'not_found_error')).code,
    ).toBe(ErrorCode.P_MODEL_NOT_FOUND);
  });

  test('overloaded_error body type → P_5XX', () => {
    expect(
      classifyAnthropicError(makeApiErr(529, 'overloaded_error')).code,
    ).toBe(ErrorCode.P_5XX);
  });

  test('undefined status (connection) → P_NETWORK', () => {
    expect(classifyAnthropicError(makeApiErr(undefined)).code).toBe(
      ErrorCode.P_NETWORK,
    );
  });

  test('plain network Error → P_NETWORK', () => {
    const err = new Error('fetch failed: ECONNREFUSED');
    expect(classifyAnthropicError(err).code).toBe(ErrorCode.P_NETWORK);
  });

  test('AbortError re-thrown verbatim', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(() => classifyAnthropicError(abort)).toThrow(abort);
  });

  test('passes NimbusError through', () => {
    const e = new NimbusError(ErrorCode.P_AUTH, {});
    expect(classifyAnthropicError(e)).toBe(e);
  });
});
