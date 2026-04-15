import { describe, expect, test, beforeEach } from 'bun:test';
import {
  clearOverride,
  currentRouting,
  loadRoutingFromConfig,
  resetRouting,
  routeModel,
  setOverride,
} from '../../src/core/modelRouter.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import { DEFAULT_ROUTING } from '../../src/core/modelClasses.ts';

describe('SPEC-106: modelRouter', () => {
  beforeEach(() => {
    resetRouting();
  });

  test('default table routes flagship to opus', () => {
    const r = routeModel('flagship');
    expect(r.providerId).toBe('anthropic');
    expect(r.modelId).toBe('claude-opus-4-6');
  });

  test('default table routes budget', () => {
    const r = routeModel('budget');
    expect(r.providerId).toBe('anthropic');
  });

  test('unknown class throws S_CONFIG_INVALID', () => {
    try {
      routeModel('nope' as unknown as 'flagship');
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.S_CONFIG_INVALID);
    }
  });

  test('setOverride reflects in subsequent routeModel', () => {
    setOverride('workhorse', { providerId: 'groq', modelId: 'llama-3.3-70b' });
    expect(routeModel('workhorse').providerId).toBe('groq');
    clearOverride('workhorse');
    expect(routeModel('workhorse').providerId).toBe('anthropic');
  });

  test('loadRoutingFromConfig validates providers', () => {
    const known = new Set(['anthropic']);
    try {
      loadRoutingFromConfig({
        ...DEFAULT_ROUTING,
        workhorse: { providerId: 'bogus', modelId: 'x' },
      }, known);
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.S_CONFIG_INVALID);
    }
  });

  test('currentRouting returns copy', () => {
    const a = currentRouting();
    expect(a.flagship?.providerId).toBe('anthropic');
  });
});
