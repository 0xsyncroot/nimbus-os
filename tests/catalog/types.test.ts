import { describe, expect, test } from 'bun:test';
import { ModelDescriptorSchema } from '../../src/catalog/types';

describe('SPEC-903: ModelDescriptor schema', () => {
  test('rejects missing id', () => {
    expect(() =>
      ModelDescriptorSchema.parse({
        provider: 'anthropic',
        source: 'live',
      } as unknown),
    ).toThrow();
  });

  test('rejects missing provider', () => {
    expect(() =>
      ModelDescriptorSchema.parse({ id: 'm', source: 'live' } as unknown),
    ).toThrow();
  });

  test('accepts minimal with optional fields missing', () => {
    const d = ModelDescriptorSchema.parse({
      id: 'gpt-4o',
      provider: 'openai',
      source: 'live',
    });
    expect(d.id).toBe('gpt-4o');
    expect(d.classHint).toBeUndefined();
  });

  test('rejects extra keys (strict)', () => {
    expect(() =>
      ModelDescriptorSchema.parse({
        id: 'm',
        provider: 'p',
        source: 'live',
        extra: 1,
      } as unknown),
    ).toThrow();
  });

  test('accepts priceHint unknown string', () => {
    const d = ModelDescriptorSchema.parse({
      id: 'm',
      provider: 'p',
      source: 'curated',
      priceHint: 'unknown',
    });
    expect(d.priceHint).toBe('unknown');
  });
});
