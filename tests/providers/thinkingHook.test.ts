import { describe, expect, test } from 'bun:test';
import type { CanonicalRequest } from '../../src/ir/types';
import { toAnthropicRequest } from '../../src/providers/anthropic';
import { streamOpenAICompat } from '../../src/providers/openaiCompat';

describe('SPEC-206 T4: Anthropic adapter injects thinking when applied', () => {
  test('reasoning applied:high → params.thinking enabled with budget 8192', () => {
    const req: CanonicalRequest = {
      model: 'claude-opus-4-6',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'high', applied: true },
    };
    const out = toAnthropicRequest(req) as unknown as {
      thinking?: { type: string; budget_tokens: number };
    };
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  test('reasoning applied:medium → budget 4096', () => {
    const req: CanonicalRequest = {
      model: 'claude-sonnet-4-6',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'medium', applied: true },
    };
    const out = toAnthropicRequest(req) as unknown as {
      thinking?: { budget_tokens: number };
    };
    expect(out.thinking?.budget_tokens).toBe(4096);
  });

  test('reasoning not applied → no thinking param', () => {
    const req: CanonicalRequest = {
      model: 'claude-haiku-4-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'high', applied: false },
    };
    const out = toAnthropicRequest(req) as unknown as { thinking?: unknown };
    expect(out.thinking).toBeUndefined();
  });

  test('no reasoning field → no thinking param (backward compat)', () => {
    const req: CanonicalRequest = {
      model: 'claude-sonnet-4-6',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    };
    const out = toAnthropicRequest(req) as unknown as { thinking?: unknown };
    expect(out.thinking).toBeUndefined();
  });
});

describe('SPEC-206 T4: OpenAI-compat adapter injects reasoning_effort', () => {
  function captureClient(): {
    captured: { reasoning_effort?: string; model?: string };
    client: { chat: { completions: { create: (p: unknown) => Promise<AsyncIterable<unknown>> } } };
  } {
    const captured: { reasoning_effort?: string; model?: string } = {};
    return {
      captured,
      client: {
        chat: {
          completions: {
            create: async (p: unknown) => {
              const pr = p as typeof captured;
              if (pr.model !== undefined) captured.model = pr.model;
              if (pr.reasoning_effort !== undefined) captured.reasoning_effort = pr.reasoning_effort;
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

  async function drain(
    req: CanonicalRequest,
    client: ReturnType<typeof captureClient>['client'],
  ): Promise<void> {
    for await (const _ of streamOpenAICompat({
      client: client as unknown as Parameters<typeof streamOpenAICompat>[0]['client'],
      req,
      signal: new AbortController().signal,
    })) {
      // drain
    }
  }

  test('reasoning-capable model + applied:high → reasoning_effort=high sent', async () => {
    const { captured, client } = captureClient();
    await drain(
      {
        model: 'o1-mini',
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
        reasoning: { effort: 'high', applied: true },
      },
      client,
    );
    expect(captured.reasoning_effort).toBe('high');
  });

  test('reasoning-capable model + applied:low → reasoning_effort=low', async () => {
    const { captured, client } = captureClient();
    await drain(
      {
        model: 'gpt-5-mini',
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
        reasoning: { effort: 'low', applied: true },
      },
      client,
    );
    expect(captured.reasoning_effort).toBe('low');
  });

  test('non-reasoning model (gpt-4o) → drop (no reasoning_effort)', async () => {
    const { captured, client } = captureClient();
    await drain(
      {
        model: 'gpt-4o',
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
        // resolver would have already set applied:false for non-capable; adapter double-guards.
        reasoning: { effort: 'high', applied: false },
      },
      client,
    );
    expect(captured.reasoning_effort).toBeUndefined();
  });

  test('applied:true but model is not reasoning (inconsistent input) → still drop', async () => {
    const { captured, client } = captureClient();
    // Defensive: even if caller passes applied:true, the adapter's isReasoningModel gate
    // prevents sending the param to non-capable endpoints (groq etc).
    await drain(
      {
        model: 'llama-3.3-70b',
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
        reasoning: { effort: 'high', applied: true },
      },
      client,
    );
    expect(captured.reasoning_effort).toBeUndefined();
  });

  test('no reasoning field → no param (backward compat)', async () => {
    const { captured, client } = captureClient();
    await drain(
      {
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
      },
      client,
    );
    expect(captured.reasoning_effort).toBeUndefined();
  });
});
