import { describe, expect, test } from 'bun:test';
import {
  isReasoningCapable,
  parseThinkingArg,
  resolveReasoning,
  toAnthropicThinking,
  toOpenAIReasoningEffort,
  ThinkingParseError,
} from '../../src/providers/reasoningResolver';

describe('SPEC-206: isReasoningCapable', () => {
  test.each([
    ['o1', true],
    ['o1-mini', true],
    ['o1-preview', true],
    ['o3-mini', true],
    ['o4-mini', true],
    ['gpt-5', true],
    ['gpt-5-mini', true],
    ['gpt-6', true],
    ['claude-opus-4-6', true],
    ['claude-sonnet-4-5', true],
    ['claude-sonnet-4-6', true],
    ['claude-haiku-4-5', false],
    ['gpt-4o', false],
    ['gpt-4o-mini', false],
    ['gpt-4-turbo', false],
    ['llama-3.3-70b', false],
    ['mixtral-8x7b', false],
    ['deepseek-chat', false],
    ['custom-o1-mimic', false], // anchored — no substring match
  ])('%s → %s', (model, expected) => {
    expect(isReasoningCapable(model)).toBe(expected as never);
  });
});

describe('SPEC-206: resolveReasoning precedence', () => {
  test('capable + no cue/session → medium applied', () => {
    const r = resolveReasoning({
      modelId: 'o1-mini',
      cueEffort: null,
      sessionEffort: null,
    });
    expect(r).toEqual({ effort: 'medium', applied: true });
  });

  test('capable + cue only → cue wins', () => {
    const r = resolveReasoning({
      modelId: 'claude-opus-4-6',
      cueEffort: 'high',
      sessionEffort: null,
    });
    expect(r).toEqual({ effort: 'high', applied: true });
  });

  test('capable + session only → session wins', () => {
    const r = resolveReasoning({
      modelId: 'claude-sonnet-4-6',
      cueEffort: null,
      sessionEffort: 'low',
    });
    expect(r).toEqual({ effort: 'low', applied: true });
  });

  test('capable + session + cue → session beats cue', () => {
    const r = resolveReasoning({
      modelId: 'o1-mini',
      cueEffort: 'high',
      sessionEffort: 'low',
    });
    expect(r).toEqual({ effort: 'low', applied: true });
  });

  test('capable + session=off → off applied:false', () => {
    const r = resolveReasoning({
      modelId: 'o1-mini',
      cueEffort: 'high',
      sessionEffort: 'off',
    });
    expect(r).toEqual({ effort: 'off', applied: false });
  });

  test('not capable + any cue → off applied:false', () => {
    const r = resolveReasoning({
      modelId: 'gpt-4o',
      cueEffort: 'high',
      sessionEffort: null,
    });
    expect(r).toEqual({ effort: 'off', applied: false });
  });

  test('not capable + session → off applied:false (silent drop)', () => {
    const r = resolveReasoning({
      modelId: 'llama-3.3-70b',
      cueEffort: null,
      sessionEffort: 'high',
    });
    expect(r).toEqual({ effort: 'off', applied: false });
  });
});

describe('SPEC-206: toAnthropicThinking', () => {
  test('applied high → thinking block with budget 8192', () => {
    const out = toAnthropicThinking({ effort: 'high', applied: true });
    expect(out).toEqual({ thinking: { type: 'enabled', budget_tokens: 8192 } });
  });

  test('applied medium → budget 4096', () => {
    const out = toAnthropicThinking({ effort: 'medium', applied: true });
    expect(out).toEqual({ thinking: { type: 'enabled', budget_tokens: 4096 } });
  });

  test('applied low → budget 2048', () => {
    const out = toAnthropicThinking({ effort: 'low', applied: true });
    expect(out).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } });
  });

  test('not applied → empty object (no param)', () => {
    const out = toAnthropicThinking({ effort: 'off', applied: false });
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe('SPEC-206: toOpenAIReasoningEffort', () => {
  test('applied high → reasoning_effort high', () => {
    expect(toOpenAIReasoningEffort({ effort: 'high', applied: true })).toEqual({
      reasoning_effort: 'high',
    });
  });

  test('applied medium → reasoning_effort medium', () => {
    expect(toOpenAIReasoningEffort({ effort: 'medium', applied: true })).toEqual({
      reasoning_effort: 'medium',
    });
  });

  test('applied low/minimal both → reasoning_effort low', () => {
    expect(toOpenAIReasoningEffort({ effort: 'low', applied: true })).toEqual({
      reasoning_effort: 'low',
    });
    expect(toOpenAIReasoningEffort({ effort: 'minimal', applied: true })).toEqual({
      reasoning_effort: 'low',
    });
  });

  test('not applied → empty object', () => {
    expect(
      Object.keys(toOpenAIReasoningEffort({ effort: 'off', applied: false })),
    ).toHaveLength(0);
  });
});

describe('SPEC-206: parseThinkingArg', () => {
  test.each([
    ['off', 'off'],
    ['minimal', 'minimal'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['on', 'medium'], // ergonomic
    ['HIGH', 'high'],
    ['  low  ', 'low'],
  ])('%s → %s', (input, expected) => {
    expect(parseThinkingArg(input)).toBe(expected as never);
  });

  test.each(['xhigh', 'ultra', '', 'DROP TABLE', 'super', 'normal'])(
    'rejects %s → ThinkingParseError',
    (bad) => {
      try {
        parseThinkingArg(bad);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ThinkingParseError);
      }
    },
  );
});
