import { describe, expect, test } from 'bun:test';
import { InitAnswersSchema, __testing } from '../../src/onboard/questions.ts';

describe('SPEC-901 + Task #31: endpoint + baseUrl prompts', () => {
  test('isLikelyUrl accepts http/https, rejects garbage', () => {
    expect(__testing.isLikelyUrl('http://localhost:9000/v1')).toBe(true);
    expect(__testing.isLikelyUrl('https://api.example.com/v1')).toBe(true);
    expect(__testing.isLikelyUrl('ftp://example.com')).toBe(false);
    expect(__testing.isLikelyUrl('not a url')).toBe(false);
    expect(__testing.isLikelyUrl('')).toBe(false);
  });

  test('endpoint="custom" requires baseUrl', () => {
    const bases = {
      workspaceName: 'test-ws',
      primaryUseCase: 'daily assistant',
      voice: 'casual' as const,
      language: 'en' as const,
      provider: 'openai' as const,
      modelClass: 'workhorse' as const,
      bashPreset: 'balanced' as const,
    };
    expect(() => InitAnswersSchema.parse({ ...bases, endpoint: 'custom' })).toThrow();
    expect(() =>
      InitAnswersSchema.parse({ ...bases, endpoint: 'custom', baseUrl: 'http://localhost:9000/v1' }),
    ).not.toThrow();
  });

  test('endpoint accepts known values without baseUrl', () => {
    const bases = {
      workspaceName: 'test-ws',
      primaryUseCase: 'daily assistant',
      voice: 'casual' as const,
      language: 'en' as const,
      provider: 'openai' as const,
      modelClass: 'workhorse' as const,
      bashPreset: 'balanced' as const,
    };
    for (const ep of ['openai', 'groq', 'deepseek', 'ollama'] as const) {
      expect(() => InitAnswersSchema.parse({ ...bases, endpoint: ep })).not.toThrow();
    }
  });

  test('baseUrl must be a valid URL', () => {
    const bases = {
      workspaceName: 'test-ws',
      primaryUseCase: 'daily assistant',
      voice: 'casual' as const,
      language: 'en' as const,
      provider: 'openai' as const,
      modelClass: 'workhorse' as const,
      bashPreset: 'balanced' as const,
      endpoint: 'custom' as const,
    };
    expect(() => InitAnswersSchema.parse({ ...bases, baseUrl: 'not-a-url' })).toThrow();
    expect(() =>
      InitAnswersSchema.parse({ ...bases, baseUrl: 'http://localhost:9000/v1' }),
    ).not.toThrow();
  });
});
