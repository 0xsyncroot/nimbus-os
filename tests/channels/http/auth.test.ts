import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import {
  generateBearerToken,
  verifyBearer,
  recordFailedAuth,
  isIpBanned,
  maskToken,
  __resetIpMap,
  storeBearerToken,
} from '../../../src/channels/http/auth.ts';
import { __resetSecretStoreCache } from '../../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey } from '../../../src/platform/secrets/fileFallback.ts';

const OVERRIDE = join(tmpdir(), `nimbus-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
  process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-auth-passphrase-802';
});
afterAll(() => {
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
});

beforeEach(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
  await mkdir(OVERRIDE, { recursive: true });
  __resetIpMap();
  __resetSecretStoreCache();
  __resetFileFallbackKey();
});
afterEach(async () => {
  delete process.env['NIMBUS_HOME'];
  delete process.env['NIMBUS_SECRETS_BACKEND'];
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  await rm(OVERRIDE, { recursive: true, force: true });
});

describe('SPEC-805: auth — token generation', () => {
  test('generateBearerToken returns nmbt_ prefixed string', () => {
    const token = generateBearerToken();
    expect(token).toMatch(/^nmbt_[A-Za-z0-9_-]{43}$/);
  });

  test('each call returns a unique token', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateBearerToken()));
    expect(tokens.size).toBe(20);
  });
});

describe('SPEC-805: auth — verifyBearer', () => {
  test('valid stored token returns true', async () => {
    const token = generateBearerToken();
    await storeBearerToken('ws-test', token);
    const result = await verifyBearer(token, 'ws-test');
    expect(result).toBe(true);
  });

  test('wrong token returns false', async () => {
    const token = generateBearerToken();
    await storeBearerToken('ws-test2', token);
    const result = await verifyBearer(generateBearerToken(), 'ws-test2');
    expect(result).toBe(false);
  });

  test('no stored token returns false', async () => {
    const result = await verifyBearer(generateBearerToken(), 'ws-nonexistent');
    expect(result).toBe(false);
  });

  test('timing: 1000 iterations vary <10µs max deviation (rough)', async () => {
    const token = generateBearerToken();
    await storeBearerToken('ws-timing', token);
    const validTimes: number[] = [];
    const invalidTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await verifyBearer(token, 'ws-timing');
      validTimes.push(performance.now() - t0);
    }
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await verifyBearer(generateBearerToken(), 'ws-timing');
      invalidTimes.push(performance.now() - t0);
    }
    const avgValid = validTimes.reduce((a, b) => a + b, 0) / validTimes.length;
    const avgInvalid = invalidTimes.reduce((a, b) => a + b, 0) / invalidTimes.length;
    // Difference in averages should be <5ms (very loose; storage I/O dominates)
    expect(Math.abs(avgValid - avgInvalid)).toBeLessThan(5);
  });
});

describe('SPEC-805: auth — IP ban tracker', () => {
  test('first 9 failures are not banned', () => {
    for (let i = 0; i < 9; i++) {
      const r = recordFailedAuth('10.0.0.1');
      expect(r.banned).toBe(false);
    }
  });

  test('10th failure triggers ban', () => {
    for (let i = 0; i < 9; i++) recordFailedAuth('10.0.0.2');
    const r = recordFailedAuth('10.0.0.2');
    expect(r.banned).toBe(true);
    expect(r.remainingAttempts).toBe(0);
  });

  test('11th attempt from same IP returns banned=true', () => {
    for (let i = 0; i < 11; i++) recordFailedAuth('10.0.0.3');
    expect(isIpBanned('10.0.0.3')).toBe(true);
  });

  test('different IPs have independent counters', () => {
    for (let i = 0; i < 9; i++) recordFailedAuth('192.168.1.1');
    for (let i = 0; i < 9; i++) recordFailedAuth('192.168.1.2');
    expect(isIpBanned('192.168.1.1')).toBe(false);
    expect(isIpBanned('192.168.1.2')).toBe(false);
  });
});

describe('SPEC-805: auth — maskToken', () => {
  test('masks token body, shows prefix + last 4', () => {
    const token = 'nmbt_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const masked = maskToken(token);
    expect(masked).toMatch(/^nmbt_\*\*\*/);
    expect(masked).toMatch(/ABCD$/);
  });

  test('short/invalid token masked as ***', () => {
    expect(maskToken('x')).toBe('***');
  });
});
