import { describe, expect, test } from 'bun:test';
import { inferClass, enrichClass } from '../../src/catalog/classify';

describe('SPEC-903: classInferrer', () => {
  test.each([
    ['claude-opus-4-6', 'flagship'],
    ['claude-sonnet-4-6', 'workhorse'],
    ['claude-haiku-4-5', 'budget'],
    ['gpt-4o', 'workhorse'],
    ['gpt-4o-mini', 'budget'],
    ['o1-mini', 'reasoning'],
    ['o3-mini', 'reasoning'],
    ['gpt-5-mini', 'reasoning'],
    ['deepseek-r1', 'reasoning'],
    ['llama-3.3-70b', 'local'],
    ['mixtral-8x22b', 'local'],
    ['qwen-2.5-coder', 'local'],
  ])('maps %s → %s', (id, expected) => {
    expect(inferClass(id)).toBe(expected as never);
  });

  test('returns undefined for unrecognized', () => {
    expect(inferClass('mystery-model-xyz')).toBeUndefined();
  });

  test('enrichClass preserves existing classHint', () => {
    const d = enrichClass({
      id: 'claude-opus-4-6',
      provider: 'anthropic',
      source: 'live',
      classHint: 'workhorse',
    });
    expect(d.classHint).toBe('workhorse');
  });

  test('enrichClass fills in missing classHint', () => {
    const d = enrichClass({
      id: 'claude-opus-4-6',
      provider: 'anthropic',
      source: 'live',
    });
    expect(d.classHint).toBe('flagship');
  });
});
