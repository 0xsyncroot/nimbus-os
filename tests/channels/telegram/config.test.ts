// config.test.ts — SPEC-808 T1: Telegram vault-config helpers.
// Uses an in-memory SecretStore injected via NIMBUS_SECRETS_BACKEND=file + tmpdir.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetSecretStoreCache } from '../../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey } from '../../../src/platform/secrets/fileFallback.ts';
import {
  addAllowedUserId,
  clearAllTelegramConfig,
  getAllowedUserIds,
  getTelegramBotToken,
  readSummary,
  removeAllowedUserId,
  setTelegramBotToken,
} from '../../../src/channels/telegram/config.ts';
import { createWorkspaceDir } from '../../../src/storage/workspaceStore.ts';
import { switchWorkspace } from '../../../src/core/workspace.ts';
import { NimbusError } from '../../../src/observability/errors.ts';

describe('SPEC-808 T1: telegram/config', () => {
  let workDir: string;
  let wsId: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nimbus-tg-config-'));
    process.env['NIMBUS_HOME'] = workDir;
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-pass-do-not-use';
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    __resetSecretStoreCache();
    __resetFileFallbackKey();

    const { meta } = await createWorkspaceDir({ name: 'tg-test' });
    wsId = meta.id;
    await switchWorkspace(wsId);
  });

  afterEach(async () => {
    delete process.env['NIMBUS_HOME'];
    delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    delete process.env['NIMBUS_SECRETS_BACKEND'];
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    await rm(workDir, { recursive: true, force: true });
  });

  test('getTelegramBotToken returns null when unset', async () => {
    const v = await getTelegramBotToken(wsId);
    expect(v).toBeNull();
  });

  test('setTelegramBotToken + getTelegramBotToken roundtrip', async () => {
    const token = '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567_-';
    await setTelegramBotToken(token, wsId);
    const v = await getTelegramBotToken(wsId);
    expect(v).toBe(token);
  });

  test('setTelegramBotToken rejects short token', async () => {
    await expect(setTelegramBotToken('abc', wsId)).rejects.toThrow(NimbusError);
  });

  test('setTelegramBotToken rejects malformed token (no colon)', async () => {
    await expect(
      setTelegramBotToken('1234567890abcdefghijklmnop', wsId),
    ).rejects.toThrow(NimbusError);
  });

  test('addAllowedUserId + getAllowedUserIds', async () => {
    await addAllowedUserId(12345, wsId);
    await addAllowedUserId(67890, wsId);
    const ids = await getAllowedUserIds(wsId);
    expect(ids).toEqual([12345, 67890]);
  });

  test('addAllowedUserId idempotent on duplicate', async () => {
    await addAllowedUserId(12345, wsId);
    await addAllowedUserId(12345, wsId);
    const ids = await getAllowedUserIds(wsId);
    expect(ids).toEqual([12345]);
  });

  test('addAllowedUserId rejects invalid ids', async () => {
    await expect(addAllowedUserId(0, wsId)).rejects.toThrow(NimbusError);
    await expect(addAllowedUserId(-5, wsId)).rejects.toThrow(NimbusError);
    await expect(addAllowedUserId(1.5, wsId)).rejects.toThrow(NimbusError);
  });

  test('removeAllowedUserId drops id', async () => {
    await addAllowedUserId(12345, wsId);
    await addAllowedUserId(67890, wsId);
    await removeAllowedUserId(12345, wsId);
    const ids = await getAllowedUserIds(wsId);
    expect(ids).toEqual([67890]);
  });

  test('removeAllowedUserId no-op on unknown id', async () => {
    await addAllowedUserId(12345, wsId);
    await removeAllowedUserId(99999, wsId);
    const ids = await getAllowedUserIds(wsId);
    expect(ids).toEqual([12345]);
  });

  test('readSummary aggregates state', async () => {
    const token = '987654321:ZYXWVUTSRQPONMLKJIHGFEDCBA9876543-_a';
    await setTelegramBotToken(token, wsId);
    await addAllowedUserId(42, wsId);
    const summary = await readSummary(wsId);
    expect(summary.tokenPresent).toBe(true);
    expect(summary.allowedUserIds).toEqual([42]);
  });

  test('clearAllTelegramConfig wipes token + allowlist', async () => {
    const token = '987654321:ZYXWVUTSRQPONMLKJIHGFEDCBA9876543-_a';
    await setTelegramBotToken(token, wsId);
    await addAllowedUserId(42, wsId);
    await clearAllTelegramConfig(wsId);
    const summary = await readSummary(wsId);
    expect(summary.tokenPresent).toBe(false);
    expect(summary.allowedUserIds).toEqual([]);
  });
});
