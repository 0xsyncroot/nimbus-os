import { describe, expect, test } from 'bun:test';
import type { CanonicalRequest } from '../../src/ir/types';
import {
  isReasoningModel,
  streamOpenAICompat,
} from '../../src/providers/openaiCompat';

describe('SPEC-203: isReasoningModel', () => {
  test('matches OpenAI o-series (o1, o3, o4)', () => {
    expect(isReasoningModel('o1')).toBe(true);
    expect(isReasoningModel('o1-mini')).toBe(true);
    expect(isReasoningModel('o1-preview')).toBe(true);
    expect(isReasoningModel('o3-mini')).toBe(true);
    expect(isReasoningModel('o4-mini')).toBe(true);
  });

  test('matches gpt-5.x / gpt-5-mini / gpt-6', () => {
    expect(isReasoningModel('gpt-5')).toBe(true);
    expect(isReasoningModel('gpt-5-mini')).toBe(true);
    expect(isReasoningModel('gpt-5.4-mini')).toBe(true);
    expect(isReasoningModel('gpt-6')).toBe(true);
  });

  test('rejects non-reasoning models', () => {
    expect(isReasoningModel('gpt-4o')).toBe(false);
    expect(isReasoningModel('gpt-4o-mini')).toBe(false);
    expect(isReasoningModel('gpt-4-turbo')).toBe(false);
    expect(isReasoningModel('gpt-3.5-turbo')).toBe(false);
    expect(isReasoningModel('llama-3.3-70b')).toBe(false);
    expect(isReasoningModel('deepseek-chat')).toBe(false);
    expect(isReasoningModel('gemma-2-9b')).toBe(false);
    expect(isReasoningModel('ollama/llama3')).toBe(false);
  });

  test('case-insensitive', () => {
    expect(isReasoningModel('O1-MINI')).toBe(true);
    expect(isReasoningModel('GPT-5')).toBe(true);
  });

  test('does not false-match substrings (e.g. model names containing "o1" later)', () => {
    expect(isReasoningModel('custom-o1-mimic')).toBe(false);
    expect(isReasoningModel('myorg/gpt-5-clone')).toBe(false);
  });
});

describe('SPEC-203: request params — reasoning model switch', () => {
  // Capture the create() params to assert the param name sent to the wire.
  function captureClient(): {
    captured: { model?: string; max_tokens?: number; max_completion_tokens?: number; temperature?: number };
    client: { chat: { completions: { create: (p: unknown) => Promise<AsyncIterable<unknown>> } } };
  } {
    const captured: {
      model?: string;
      max_tokens?: number;
      max_completion_tokens?: number;
      temperature?: number;
    } = {};
    return {
      captured,
      client: {
        chat: {
          completions: {
            create: async (p: unknown) => {
              const pr = p as typeof captured;
              if (pr.model !== undefined) captured.model = pr.model;
              if (pr.max_tokens !== undefined) captured.max_tokens = pr.max_tokens;
              if (pr.max_completion_tokens !== undefined) {
                captured.max_completion_tokens = pr.max_completion_tokens;
              }
              if (pr.temperature !== undefined) captured.temperature = pr.temperature;
              async function* gen(): AsyncIterable<unknown> {
                yield {
                  id: 'c1',
                  model: captured.model,
                  choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
                };
                yield {
                  id: 'c1',
                  model: captured.model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                };
              }
              return gen();
            },
          },
        },
      },
    };
  }

  async function run(model: string): ReturnType<typeof captureClient>['captured'] extends infer _ ? Promise<ReturnType<typeof captureClient>['captured']> : never {
    const { captured, client } = captureClient();
    const req: CanonicalRequest = {
      model,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 512,
      temperature: 0.7,
    };
    for await (const _ of streamOpenAICompat({
      client: client as unknown as Parameters<typeof streamOpenAICompat>[0]['client'],
      req,
      signal: new AbortController().signal,
    })) {
      // drain
    }
    return captured;
  }

  test('reasoning model → uses max_completion_tokens, drops temperature', async () => {
    const p = await run('gpt-5-mini');
    expect(p.max_completion_tokens).toBe(512);
    expect(p.max_tokens).toBeUndefined();
    expect(p.temperature).toBeUndefined();
  });

  test('reasoning model o1-mini → uses max_completion_tokens', async () => {
    const p = await run('o1-mini');
    expect(p.max_completion_tokens).toBe(512);
    expect(p.max_tokens).toBeUndefined();
  });

  test('non-reasoning model gpt-4o-mini → uses max_tokens + temperature', async () => {
    const p = await run('gpt-4o-mini');
    expect(p.max_tokens).toBe(512);
    expect(p.max_completion_tokens).toBeUndefined();
    expect(p.temperature).toBe(0.7);
  });

  test('non-reasoning model llama-3.3-70b → uses max_tokens', async () => {
    const p = await run('llama-3.3-70b');
    expect(p.max_tokens).toBe(512);
    expect(p.max_completion_tokens).toBeUndefined();
  });
});
