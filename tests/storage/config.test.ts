// tests/storage/config.test.ts — SPEC-501 §6.1 unit + integration.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configDir } from '../../src/platform/paths.ts';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';
import {
  NimbusConfigSchema,
  containsRawSecret,
} from '../../src/storage/config/schema.ts';
import { mergeLayers } from '../../src/storage/config/merge.ts';
import {
  loadConfig,
  loadConfigWithTrace,
  writeUserConfig,
} from '../../src/storage/config/loader.ts';
import {
  createProfile,
  deleteProfile,
  listProfiles,
  switchProfile,
} from '../../src/storage/config/profiles.ts';

const OVERRIDE = join(
  tmpdir(),
  `nimbus-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const ENV_KEYS = [
  'NIMBUS_PROVIDER',
  'NIMBUS_MODEL',
  'NIMBUS_PERMISSION_MODE',
  'NIMBUS_LOG_LEVEL',
  'NIMBUS_PROFILE',
];

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  await mkdir(OVERRIDE, { recursive: true });
});
afterAll(async () => {
  delete process.env['NIMBUS_HOME'];
  await rm(OVERRIDE, { recursive: true, force: true });
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await rm(configDir(), { recursive: true, force: true });
});

describe('SPEC-501: schema', () => {
  test('defaults populate when empty input', () => {
    const parsed = NimbusConfigSchema.parse({});
    expect(parsed.provider.default).toBe('anthropic');
    expect(parsed.permissions.mode).toBe('default');
    expect(parsed.logging.level).toBe('info');
    expect(parsed.cost.trackEnabled).toBe(true);
  });

  test('missing required fields after partial → surfaces JSON pointer', () => {
    const result = NimbusConfigSchema.safeParse({
      provider: { default: 'not-a-provider', model: 'foo' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('/'));
      expect(paths.some((p) => p.includes('provider'))).toBe(true);
    }
  });

  test('containsRawSecret catches sk-, ghp_, Bearer', () => {
    expect(containsRawSecret('sk-ABCDEFGHIJKLMNOPQRST')).toBe(true);
    expect(containsRawSecret('ghp_ABCDEFGHIJKLMNOPQRST')).toBe(true);
    expect(containsRawSecret('Bearer abcdefghijklmnopqrst12345')).toBe(true);
    expect(containsRawSecret('no secret here')).toBe(false);
  });

  test('raw secret-shaped value rejected', () => {
    const result = NimbusConfigSchema.safeParse({
      permissions: { rules: ['allow sk-ABCDEFGHIJKLMNOPQRST'] },
    });
    expect(result.success).toBe(false);
  });
});

describe('SPEC-501: merge (array replace, deep object)', () => {
  test('CLI beats env beats workspace beats user beats default', () => {
    const { merged } = mergeLayers([
      { source: 'default', data: { provider: { default: 'anthropic', model: 'd' } } },
      { source: 'user', data: { provider: { model: 'u' } } },
      { source: 'profile', data: {} },
      { source: 'workspace', data: { provider: { model: 'w' } } },
      { source: 'env', data: { provider: { model: 'e' } } },
      { source: 'cli', data: { provider: { model: 'c' } } },
    ]);
    expect((merged as { provider: { model: string } }).provider.model).toBe('c');
  });

  test('array replace — workspace rules [C] overrides user [A,B]', () => {
    const { merged } = mergeLayers([
      { source: 'user', data: { permissions: { rules: ['A', 'B'] } } },
      { source: 'workspace', data: { permissions: { rules: ['C'] } } },
    ]);
    const m = merged as { permissions: { rules: string[] } };
    expect(m.permissions.rules).toEqual(['C']);
  });

  test('trace records final source per field', () => {
    const { trace } = mergeLayers([
      { source: 'default', data: { provider: { model: 'd' } } },
      { source: 'cli', data: { provider: { model: 'c' } } },
    ]);
    const modelTrace = trace.find((t) => t.field === '/provider/model');
    expect(modelTrace?.source).toBe('cli');
  });
});

describe('SPEC-501: loadConfig precedence', () => {
  test('returns defaults when no layers set', async () => {
    const cfg = await loadConfig({});
    expect(cfg.provider.default).toBe('anthropic');
  });

  test('CLI --model beats env NIMBUS_MODEL', async () => {
    process.env['NIMBUS_MODEL'] = 'env-model';
    const cfg = await loadConfig({ model: 'cli-model' });
    expect(cfg.provider.model).toBe('cli-model');
  });

  test('env NIMBUS_MODEL beats user config', async () => {
    await writeUserConfig({ provider: { model: 'user-model' } });
    process.env['NIMBUS_MODEL'] = 'env-model';
    const cfg = await loadConfig({});
    expect(cfg.provider.model).toBe('env-model');
  });

  test('workspace config beats user config', async () => {
    await writeUserConfig({ provider: { model: 'user-model' } });
    const wsRoot = join(OVERRIDE, 'ws');
    await mkdir(wsRoot, { recursive: true });
    await writeFile(
      join(wsRoot, 'nimbus.config.json'),
      JSON.stringify({ provider: { model: 'ws-model' } }),
    );
    const cfg = await loadConfig({}, wsRoot);
    expect(cfg.provider.model).toBe('ws-model');
  });

  test('corrupt user config → S_CONFIG_INVALID', async () => {
    await mkdir(configDir(), { recursive: true });
    await writeFile(join(configDir(), 'config.json'), '{ not valid json');
    try {
      await loadConfig({});
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.S_CONFIG_INVALID);
    }
  });

  test('invalid schema → issues contain JSON pointer', async () => {
    await mkdir(configDir(), { recursive: true });
    await writeFile(
      join(configDir(), 'config.json'),
      JSON.stringify({ provider: { default: 'bogus' } }),
    );
    try {
      await loadConfig({});
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      const ctx = (err as NimbusError).context as {
        issues?: Array<{ pointer: string }>;
      };
      expect(ctx.issues?.[0]?.pointer.includes('provider')).toBe(true);
    }
  });

  test('trace surfaces merge origins', async () => {
    process.env['NIMBUS_MODEL'] = 'env-model';
    const { trace } = await loadConfigWithTrace({ model: 'cli-model' });
    const modelEntry = trace.find((t) => t.field === '/provider/model');
    expect(modelEntry?.source).toBe('cli');
  });
});

describe('SPEC-501: profiles', () => {
  test('create + list + switch + delete round-trip', async () => {
    await createProfile('work', { provider: { model: 'sonnet-4-6' } });
    await createProfile('personal', { provider: { model: 'haiku-4-5' } });
    const all = await listProfiles();
    expect(all).toContain('work');
    expect(all).toContain('personal');
    await switchProfile('work');
    // NIMBUS_PROFILE env should win over active pointer? — spec: CLI > env > user;
    // active-profile acts as user-level default. Without env, active applies.
    const cfg = await loadConfig({});
    expect(cfg.provider.model).toBe('sonnet-4-6');
    await deleteProfile('work');
    const after = await listProfiles();
    expect(after).not.toContain('work');
  });

  test('NIMBUS_PROFILE=work picks work.json', async () => {
    await createProfile('work', { provider: { model: 'sonnet-4-5' } });
    process.env['NIMBUS_PROFILE'] = 'work';
    const cfg = await loadConfig({});
    expect(cfg.provider.model).toBe('sonnet-4-5');
  });

  test('rejects invalid profile name', async () => {
    try {
      await createProfile('../evil');
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    }
  });

  test('switchProfile on non-existent → error', async () => {
    try {
      await switchProfile('ghost');
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
    }
  });
});
