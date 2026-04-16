import { describe, expect, test } from 'bun:test';
import { ENDPOINTS, getEndpoint } from '../../src/providers/openaiCompat';
import { lookupPrice, __resetPriceWarnings } from '../../src/cost/priceTable';
import { validateKeyFormat, detectProviderFromKey } from '../../src/onboard/keyValidators';
import { ErrorCode, NimbusError } from '../../src/observability/errors';

const GEMINI_ENDPOINT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

describe('SPEC-827: Gemini endpoint catalog', () => {
  test('ENDPOINTS includes gemini with correct baseUrl', () => {
    expect(ENDPOINTS.gemini).toBeDefined();
    expect(ENDPOINTS.gemini.baseUrl).toBe(GEMINI_ENDPOINT_URL);
  });

  test('getEndpoint("gemini") returns correct id and apiKeyEnv', () => {
    const ep = getEndpoint('gemini');
    expect(ep.id).toBe('openai-compat:gemini');
    expect(ep.apiKeyEnv).toBe('GEMINI_API_KEY');
  });

  test('gemini capabilities: vision=both, maxContextTokens=1_000_000', () => {
    const ep = getEndpoint('gemini');
    expect(ep.capabilities.vision).toBe('both');
    expect(ep.capabilities.maxContextTokens).toBe(1_000_000);
  });
});

describe('SPEC-827: Gemini price table', () => {
  test('gemini-2.5-flash returns correct prices', () => {
    __resetPriceWarnings();
    const p = lookupPrice('gemini', 'gemini-2.5-flash');
    expect(p.in).toBe(0.30);
    expect(p.out).toBe(2.50);
    expect(p.cacheRead).toBe(0.075);
    expect(p.class).toBe('workhorse');
  });

  test('gemini-2.5-pro returns flagship pricing', () => {
    __resetPriceWarnings();
    const p = lookupPrice('gemini', 'gemini-2.5-pro');
    expect(p.in).toBe(1.25);
    expect(p.out).toBe(10.00);
    expect(p.cacheRead).toBe(0.3125);
    expect(p.class).toBe('flagship');
  });

  test('gemini-2.5-flash-lite returns budget pricing', () => {
    __resetPriceWarnings();
    const p = lookupPrice('gemini', 'gemini-2.5-flash-lite');
    expect(p.in).toBe(0.10);
    expect(p.out).toBe(0.40);
    expect(p.cacheRead).toBe(0.025);
    expect(p.class).toBe('budget');
  });

  test('gemini-2.0-flash returns budget pricing', () => {
    __resetPriceWarnings();
    const p = lookupPrice('gemini', 'gemini-2.0-flash');
    expect(p.in).toBe(0.10);
    expect(p.out).toBe(0.40);
    expect(p.cacheRead).toBe(0.025);
  });
});

describe('SPEC-827: Gemini key validation', () => {
  // Valid key: AIza + 35 alphanumeric/underscore/dash chars = 39 total
  const VALID_KEY = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';

  test('valid AIza key (39 chars) passes validateKeyFormat', () => {
    expect(() => validateKeyFormat('gemini', VALID_KEY)).not.toThrow();
  });

  test('sk-xyz fails with hint about AIza prefix', () => {
    try {
      validateKeyFormat('gemini', 'sk-xyz-invalid-key-for-gemini-provider');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(NimbusError);
      const err = e as NimbusError;
      expect(err.code).toBe(ErrorCode.T_VALIDATION);
      expect(err.context['reason']).toBe('key_format_mismatch');
      expect(String(err.context['hint'])).toContain('AIza');
    }
  });

  test('detectProviderFromKey("AIza...") returns gemini provider', () => {
    const detected = detectProviderFromKey(VALID_KEY);
    expect(detected).not.toBeNull();
    expect(detected!.provider).toBe('gemini');
    expect(detected!.kind).toBe('openai-compat');
    expect(detected!.defaultModel).toBe('gemini-2.5-flash');
    expect(detected!.defaultEndpoint).toBe('gemini');
  });

  test('detectProviderFromKey("sk-xyz") does not return gemini', () => {
    const detected = detectProviderFromKey('sk-xyz-12345');
    expect(detected?.provider).not.toBe('gemini');
  });
});
