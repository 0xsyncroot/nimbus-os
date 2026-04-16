// sessionPreferences.test.ts — SPEC-122: session-scoped preferences.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import {
  SessionPreferencesSchema,
  detectCrossSessionIntent,
  detectSetPrefIntent,
  getSessionPrefs,
  sanitizePrefValue,
  setSessionPref,
  validatePrefValue,
  __resetPrefsCache,
} from '../../src/core/sessionPreferences.ts';
import { buildSessionPrefsBlock } from '../../src/core/prompts.ts';
import { createWorkspaceDir } from '../../src/storage/workspaceStore.ts';
import { createSession } from '../../src/storage/sessionStore.ts';
import { workspacesDir } from '../../src/platform/paths.ts';
import type { SessionPreferences } from '../../src/core/sessionPreferences.ts';

const OVERRIDE = join(tmpdir(), `nimbus-prefs-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  await mkdir(OVERRIDE, { recursive: true });
});

afterAll(async () => {
  delete process.env['NIMBUS_HOME'];
  await rm(OVERRIDE, { recursive: true, force: true });
});

afterEach(async () => {
  __resetPrefsCache();
  await rm(workspacesDir(), { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeSession(): Promise<{ wsId: string; sessionId: string }> {
  const { meta: ws } = await createWorkspaceDir({ name: 'prefs-test-ws' });
  const session = await createSession(ws.id);
  return { wsId: ws.id, sessionId: session.id };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SPEC-122: SessionPreferencesSchema', () => {
  test('accepts all fields', () => {
    const prefs: SessionPreferences = { agentName: 'Nim', pronoun: 'she', language: 'vi', voice: 'warm' };
    expect(() => SessionPreferencesSchema.parse(prefs)).not.toThrow();
  });

  test('accepts empty object', () => {
    expect(() => SessionPreferencesSchema.parse({})).not.toThrow();
  });

  test('rejects agentName > 128 chars', () => {
    expect(() => SessionPreferencesSchema.parse({ agentName: 'x'.repeat(129) })).toThrow();
  });

  test('rejects language > 32 chars', () => {
    expect(() => SessionPreferencesSchema.parse({ language: 'x'.repeat(33) })).toThrow();
  });
});

describe('SPEC-122: sanitizePrefValue', () => {
  test('strips HTML tags', () => {
    expect(sanitizePrefValue('<b>Linh</b>')).toBe('Linh');
  });

  test('strips ANSI escape sequences', () => {
    const ansi = '\u001b[32mGreen\u001b[0m';
    expect(sanitizePrefValue(ansi)).toBe('Green');
  });

  test('truncates to 128 chars', () => {
    const long = 'a'.repeat(200);
    expect(sanitizePrefValue(long)).toHaveLength(128);
  });

  test('passes through clean value unchanged', () => {
    expect(sanitizePrefValue('Nimbus')).toBe('Nimbus');
  });
});

describe('SPEC-122: validatePrefValue — prompt injection defence', () => {
  test('throws X_INJECTION for control characters', () => {
    try {
      validatePrefValue('agentName', 'abc\x01def');
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.X_INJECTION);
    }
  });

  test('throws X_INJECTION for block-marker-like value', () => {
    try {
      validatePrefValue('agentName', 'SOUL');
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.X_INJECTION);
    }
  });

  test('throws X_INJECTION for [MEMORY] pattern', () => {
    try {
      validatePrefValue('agentName', '[MEMORY]');
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.X_INJECTION);
    }
  });

  test('allows normal names', () => {
    expect(() => validatePrefValue('agentName', 'Linh')).not.toThrow();
    expect(() => validatePrefValue('agentName', 'Nimbus AI')).not.toThrow();
  });
});

describe('SPEC-122: setSessionPref / getSessionPrefs — persistence', () => {
  test('set agentName → getSessionPrefs returns it', async () => {
    const { wsId, sessionId } = await makeSession();
    await setSessionPref(wsId, sessionId, 'agentName', 'Linh');
    const prefs = await getSessionPrefs(wsId, sessionId);
    expect(prefs.agentName).toBe('Linh');
  });

  test('merge: second setSessionPref adds key without removing first', async () => {
    const { wsId, sessionId } = await makeSession();
    await setSessionPref(wsId, sessionId, 'agentName', 'Linh');
    await setSessionPref(wsId, sessionId, 'language', 'vi');
    const prefs = await getSessionPrefs(wsId, sessionId);
    expect(prefs.agentName).toBe('Linh');
    expect(prefs.language).toBe('vi');
  });

  test('prefs restored from disk after cache reset (session resume)', async () => {
    const { wsId, sessionId } = await makeSession();
    await setSessionPref(wsId, sessionId, 'agentName', 'Minh');
    // Simulate new process — clear in-memory cache
    __resetPrefsCache();
    const prefs = await getSessionPrefs(wsId, sessionId);
    expect(prefs.agentName).toBe('Minh');
  });

  test('absent meta.json returns empty prefs (v0.1 sessions compat)', async () => {
    const { wsId, sessionId } = await makeSession();
    // No setSessionPref call — file absent
    const prefs = await getSessionPrefs(wsId, sessionId);
    expect(prefs).toEqual({});
  });

  test('corrupt meta.json throws S_CONFIG_INVALID', async () => {
    const { wsId, sessionId } = await makeSession();
    // Write garbage to meta.json
    const metaPath = join(workspacesDir(), wsId, 'sessions', sessionId, 'meta.json');
    await mkdir(join(workspacesDir(), wsId, 'sessions', sessionId), { recursive: true });
    await writeFile(metaPath, 'NOT JSON >>>');
    __resetPrefsCache();
    try {
      await getSessionPrefs(wsId, sessionId);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.S_CONFIG_INVALID);
    }
  });

  test('pref value is sanitized before storage', async () => {
    const { wsId, sessionId } = await makeSession();
    await setSessionPref(wsId, sessionId, 'agentName', '<b>Nim</b>');
    const prefs = await getSessionPrefs(wsId, sessionId);
    expect(prefs.agentName).not.toContain('<b>');
    expect(prefs.agentName).toContain('Nim');
  });
});

describe('SPEC-122: buildSessionPrefsBlock (prompts.ts)', () => {
  test('empty prefs → empty string (block omitted)', () => {
    expect(buildSessionPrefsBlock({})).toBe('');
  });

  test('non-empty prefs → block contains [SESSION_PREFS]', () => {
    const block = buildSessionPrefsBlock({ agentName: 'Nim' });
    expect(block).toContain('[SESSION_PREFS]');
    expect(block).toContain('agentName: Nim');
  });

  test('multiple prefs all appear in block', () => {
    const block = buildSessionPrefsBlock({ agentName: 'Nim', language: 'vi', pronoun: 'she' });
    expect(block).toContain('agentName: Nim');
    expect(block).toContain('language: vi');
    expect(block).toContain('pronoun: she');
  });

  test('voice pref is included', () => {
    const block = buildSessionPrefsBlock({ voice: 'warm' });
    expect(block).toContain('voice: warm');
  });
});

describe('SPEC-122: intent phrase detection', () => {
  test('detectSetPrefIntent — "call me X" returns agentName', () => {
    const result = detectSetPrefIntent('call me Linh');
    expect(result).not.toBeNull();
    expect(result!.key).toBe('agentName');
    expect(result!.value).toBe('Linh');
  });

  test('detectSetPrefIntent — Vietnamese "từ giờ gọi em là X"', () => {
    const result = detectSetPrefIntent('từ giờ gọi em là Minh');
    expect(result).not.toBeNull();
    expect(result!.key).toBe('agentName');
  });

  test('detectSetPrefIntent — "refer to me as X"', () => {
    const result = detectSetPrefIntent('please refer to me as Boss');
    expect(result).not.toBeNull();
    expect(result!.value).toBe('Boss');
  });

  test('detectSetPrefIntent — unrelated text returns null', () => {
    expect(detectSetPrefIntent('what is the weather?')).toBeNull();
  });

  test('detectCrossSessionIntent — "luôn luôn" returns true', () => {
    expect(detectCrossSessionIntent('luôn luôn nhớ điều này')).toBe(true);
  });

  test('detectCrossSessionIntent — "always from now on" returns true', () => {
    expect(detectCrossSessionIntent('always from now on call me Dev')).toBe(true);
  });

  test('detectCrossSessionIntent — "call me" only returns false', () => {
    expect(detectCrossSessionIntent('call me Nim')).toBe(false);
  });
});

describe('SPEC-122: MemoryTool setSessionPref — sideEffects tag', () => {
  test('createMemoryExtendedTool has readOnly=false (write side-effect)', async () => {
    const { createMemoryExtendedTool } = await import('../../src/tools/memoryTool.ts');
    const tool = createMemoryExtendedTool();
    expect(tool.readOnly).toBe(false);
  });

  test('setSessionPref action routes to sessionPreferences.setSessionPref', async () => {
    const { createMemoryExtendedTool } = await import('../../src/tools/memoryTool.ts');
    const { wsId, sessionId } = await makeSession();
    const tool = createMemoryExtendedTool();

    const ctx = {
      workspaceId: wsId,
      sessionId,
      turnId: 'turn-001',
      toolUseId: 'tu-001',
      cwd: '/',
      signal: new AbortController().signal,
      onAbort: () => {},
      permissions: {} as never,
      mode: 'default' as const,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
    };

    const result = await tool.handler({ action: 'setSessionPref', key: 'agentName', value: 'Nimbus' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.action).toBe('setSessionPref');
      expect((result.output as { key: string }).key).toBe('agentName');
    }

    // Verify it actually set the pref
    const prefs = await getSessionPrefs(wsId, sessionId);
    expect(prefs.agentName).toBe('Nimbus');
  });
});
