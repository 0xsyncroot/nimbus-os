import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import {
  createPairingSession,
  redeemPairingCode,
  __resetPairingSessions,
  __setNowFn,
} from '../../../src/channels/http/pairing.ts';
import { __resetSecretStoreCache } from '../../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey } from '../../../src/platform/secrets/fileFallback.ts';

const OVERRIDE = join(tmpdir(), `nimbus-pair-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
  process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-pair-passphrase-802';
});
afterAll(() => {
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
});

beforeEach(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
  await mkdir(OVERRIDE, { recursive: true });
  __resetPairingSessions();
  __setNowFn(() => Date.now());
  __resetSecretStoreCache();
  __resetFileFallbackKey();
});
afterEach(async () => {
  delete process.env['NIMBUS_HOME'];
  delete process.env['NIMBUS_SECRETS_BACKEND'];
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  await rm(OVERRIDE, { recursive: true, force: true });
  __setNowFn(() => Date.now());
});

describe('SPEC-805: pairing', () => {
  test('code is exactly 6 digits', async () => {
    const session = await createPairingSession('ws-001');
    expect(session.code).toMatch(/^\d{6}$/);
  });

  test('expiresAt is ~5 minutes from now', async () => {
    const before = Date.now();
    const session = await createPairingSession('ws-002');
    const after = Date.now();
    const ttl = session.expiresAt - before;
    expect(ttl).toBeGreaterThanOrEqual(4 * 60 * 1000);
    expect(session.expiresAt).toBeGreaterThanOrEqual(before + 4 * 60 * 1000);
    expect(session.expiresAt).toBeLessThanOrEqual(after + 5 * 60 * 1000 + 100);
  });

  test('valid code returns bearer token', async () => {
    const session = await createPairingSession('ws-003');
    const token = await redeemPairingCode(session.code);
    expect(token).not.toBeNull();
    expect(token).toMatch(/^nmbt_/);
  });

  test('wrong code returns null', async () => {
    await createPairingSession('ws-004');
    const token = await redeemPairingCode('000000');
    expect(token).toBeNull();
  });

  test('reuse of code rejected (one-time use)', async () => {
    const session = await createPairingSession('ws-005');
    const first = await redeemPairingCode(session.code);
    expect(first).not.toBeNull();
    const second = await redeemPairingCode(session.code);
    expect(second).toBeNull();
  });

  test('expired code returns null (mock Date.now)', async () => {
    const fakeNow = Date.now();
    __setNowFn(() => fakeNow);
    const session = await createPairingSession('ws-006');

    // Advance clock past TTL (5 min + 1ms)
    __setNowFn(() => fakeNow + 5 * 60 * 1000 + 1);

    const token = await redeemPairingCode(session.code);
    expect(token).toBeNull();
  });

  test('invalid format (non-numeric or wrong length) returns null', async () => {
    expect(await redeemPairingCode('abc')).toBeNull();
    expect(await redeemPairingCode('12345')).toBeNull();
    expect(await redeemPairingCode('1234567')).toBeNull();
    expect(await redeemPairingCode('abc123')).toBeNull();
  });

  test('workspaceId carried through to session', async () => {
    const session = await createPairingSession('my-workspace');
    expect(session.workspaceId).toBe('my-workspace');
  });
});
