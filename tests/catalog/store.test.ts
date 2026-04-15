import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtemp, stat, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CATALOG_TTL_MS,
  catalogDir,
  catalogPath,
  curatedFallback,
  endpointHash8,
  readCache,
  writeCache,
} from '../../src/catalog/store';
import type { ModelDescriptor } from '../../src/catalog/types';

let sandbox = '';
beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'nimbus-catalog-'));
  process.env['NIMBUS_HOME'] = sandbox;
});

describe('SPEC-903: endpointHash8', () => {
  test('deterministic 8-char hex', () => {
    const h = endpointHash8('https://api.openai.com/v1');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(h).toBe(endpointHash8('https://api.openai.com/v1'));
  });

  test('different endpoints get different hashes', () => {
    expect(endpointHash8('https://api.openai.com/v1')).not.toBe(
      endpointHash8('https://api.groq.com/openai/v1'),
    );
  });
});

describe('SPEC-903: file cache', () => {
  test('write + read round-trip', async () => {
    const models: ModelDescriptor[] = [
      { id: 'gpt-4o', provider: 'openai', source: 'live', fetchedAt: Date.now() },
    ];
    await writeCache('openai', 'https://api.openai.com/v1', models);
    const cached = await readCache('openai', 'https://api.openai.com/v1');
    expect(cached.hit).toBe(true);
    expect(cached.stale).toBe(false);
    expect(cached.models?.[0]?.id).toBe('gpt-4o');
    expect(cached.models?.[0]?.source).toBe('cache');
  });

  test('TTL expiry — stale flag set', async () => {
    const models: ModelDescriptor[] = [
      { id: 'gpt-4o', provider: 'openai', source: 'live' },
    ];
    await writeCache('openai', 'https://api.openai.com/v1', models);
    const future = Date.now() + CATALOG_TTL_MS + 60_000;
    const cached = await readCache('openai', 'https://api.openai.com/v1', future);
    expect(cached.hit).toBe(true);
    expect(cached.stale).toBe(true);
  });

  test('corrupt JSON → miss', async () => {
    const dir = catalogDir();
    const path = catalogPath('openai', 'https://api.openai.com/v1');
    const fs = await import('node:fs/promises');
    await fs.mkdir(dir, { recursive: true });
    await writeFile(path, '{not-json', 'utf8');
    const cached = await readCache('openai', 'https://api.openai.com/v1');
    expect(cached.hit).toBe(false);
  });

  test('missing cache → miss', async () => {
    const cached = await readCache('openai', 'https://api.openai.com/v1');
    expect(cached.hit).toBe(false);
  });

  test('cache file mode is 0644 (unix)', async () => {
    if (process.platform === 'win32') return;
    await writeCache('openai', 'https://api.openai.com/v1', [
      { id: 'gpt-4o', provider: 'openai', source: 'live' },
    ]);
    const path = catalogPath('openai', 'https://api.openai.com/v1');
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o644);
  });

  test('cache does not contain API key prefixes (sk-, sk-ant-)', async () => {
    // Ensure we never leak keys via cache — write a model list, grep the file.
    await writeCache('openai', 'https://api.openai.com/v1', [
      { id: 'gpt-4o', provider: 'openai', source: 'live' },
    ]);
    const dir = catalogDir();
    const entries = await readdir(dir);
    for (const entry of entries) {
      const content = await readFile(join(dir, entry), 'utf8');
      expect(content.toLowerCase()).not.toContain('sk-');
      expect(content.toLowerCase()).not.toContain('bearer');
      expect(content.toLowerCase()).not.toContain('api-key');
    }
  });
});

describe('SPEC-903: curatedFallback', () => {
  test('anthropic returns flagship/workhorse/budget entries', () => {
    const out = curatedFallback('anthropic');
    const classes = new Set(out.map((m) => m.classHint));
    expect(classes.has('flagship')).toBe(true);
    expect(classes.has('workhorse')).toBe(true);
    expect(classes.has('budget')).toBe(true);
    expect(out[0]!.source).toBe('curated');
  });

  test('openai has gpt-4o + o1', () => {
    const out = curatedFallback('openai');
    expect(out.some((m) => m.id === 'gpt-4o')).toBe(true);
    expect(out.some((m) => m.id === 'o1')).toBe(true);
  });

  test('unknown provider → []', () => {
    expect(curatedFallback('mystery-provider-xyz')).toEqual([]);
  });
});
