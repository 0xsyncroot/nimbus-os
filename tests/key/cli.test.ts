// tests/key/cli.test.ts — SPEC-902 bugfix #6: cross-kind workspace align via key set --base-url.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { runKeyCli } from '../../src/key/cli.ts';
import { createKeyManager } from '../../src/key/manager.ts';
import { __resetSecretStoreCache, getBest } from '../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey } from '../../src/platform/secrets/fileFallback.ts';
import { __resetDetectCache } from '../../src/platform/detect.ts';
import { runInit } from '../../src/onboard/init.ts';
import { getActiveWorkspace } from '../../src/core/workspace.ts';
import { loadWorkspace } from '../../src/storage/workspaceStore.ts';

let tmpRoot: string;

function sinkOutput(): Writable & { captured: string } {
  const out = new Writable({
    write(chunk, _enc, cb) {
      (out as Writable & { captured: string }).captured += chunk.toString();
      cb();
    },
  }) as Writable & { captured: string };
  out.captured = '';
  return out;
}

function stdinFrom(value: string): NodeJS.ReadStream {
  const r = Readable.from([value]) as unknown as NodeJS.ReadStream;
  return r;
}

beforeAll(() => {
  process.env['NIMBUS_VAULT_PASSPHRASE'] = 'cli-cross-kind-pass';
  process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
});
afterAll(() => {
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
  delete process.env['NIMBUS_SECRETS_BACKEND'];
});

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-cli-test-'));
  process.env['NIMBUS_HOME'] = tmpRoot;
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  __resetDetectCache();
});

afterEach(() => {
  delete process.env['NIMBUS_HOME'];
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetSecretStoreCache();
  __resetFileFallbackKey();
});

describe('SPEC-902 #6: key set --base-url cross-kind workspace align', () => {
  test('anthropic-kind workspace + key set openai --base-url → flips workspace to openai-compat custom', async () => {
    const initOut = sinkOutput();
    await runInit({
      noPrompt: true,
      output: initOut,
      skipKeyStep: true,
      answers: { workspaceName: 'switchws', provider: 'anthropic' },
    });
    const active = await getActiveWorkspace();
    expect(active!.defaultProvider).toBe('anthropic');
    expect(active!.defaultBaseUrl).toBeUndefined();

    const out = sinkOutput();
    const manager = createKeyManager({ secretStore: await getBest() });
    const code = await runKeyCli({
      argv: ['set', 'openai', '--key-stdin', '--base-url', 'http://localhost:9000/v1'],
      manager,
      input: stdinFrom('local-vllm-any-string'),
      output: out,
    });
    expect(code).toBe(0);

    const reloaded = await loadWorkspace(active!.id);
    expect(reloaded.meta.defaultProvider).toBe('openai-compat');
    expect(reloaded.meta.defaultEndpoint).toBe('custom');
    expect(reloaded.meta.defaultBaseUrl).toBe('http://localhost:9000/v1');

    expect(out.captured).toContain(
      'switching workspace "switchws" provider: anthropic → openai-compat (per --base-url)',
    );
    expect(out.captured).toContain('aligned: baseUrl=http://localhost:9000/v1');
    // Notice must appear BEFORE the "aligned" line (intent → action ordering).
    const noticeAt = out.captured.indexOf('switching workspace');
    const alignedAt = out.captured.indexOf('aligned: baseUrl');
    expect(noticeAt).toBeGreaterThan(-1);
    expect(alignedAt).toBeGreaterThan(noticeAt);
  });

  test('openai-compat-kind workspace + key set openai --base-url → no kind switch notice, baseUrl set', async () => {
    await runInit({
      noPrompt: true,
      output: sinkOutput(),
      skipKeyStep: true,
      answers: { workspaceName: 'sameknd', provider: 'openai' },
    });
    const active = await getActiveWorkspace();
    expect(active!.defaultProvider).toBe('openai-compat');

    const out = sinkOutput();
    const manager = createKeyManager({ secretStore: await getBest() });
    await runKeyCli({
      argv: ['set', 'openai', '--key-stdin', '--base-url', 'http://litellm:4000/v1'],
      manager,
      input: stdinFrom('proxy-key'),
      output: out,
    });
    const reloaded = await loadWorkspace(active!.id);
    expect(reloaded.meta.defaultBaseUrl).toBe('http://litellm:4000/v1');
    expect(reloaded.meta.defaultEndpoint).toBe('custom');
    expect(out.captured).not.toContain('switching workspace');
  });

  test('anthropic-kind workspace + key set anthropic --base-url → keeps kind, sets baseUrl + endpoint=custom', async () => {
    await runInit({
      noPrompt: true,
      output: sinkOutput(),
      skipKeyStep: true,
      answers: { workspaceName: 'antbase', provider: 'anthropic' },
    });
    const active = await getActiveWorkspace();

    const out = sinkOutput();
    const manager = createKeyManager({ secretStore: await getBest() });
    await runKeyCli({
      argv: [
        'set',
        'anthropic',
        '--key-stdin',
        '--base-url',
        'https://anthropic-proxy.internal/v1',
      ],
      manager,
      input: stdinFrom('sk-ant-' + 'A'.repeat(40)),
      output: out,
    });
    const reloaded = await loadWorkspace(active!.id);
    expect(reloaded.meta.defaultProvider).toBe('anthropic');
    expect(reloaded.meta.defaultBaseUrl).toBe('https://anthropic-proxy.internal/v1');
    expect(out.captured).not.toContain('switching workspace');
  });

  test('openai-compat-kind workspace + key set openai (no --base-url) → workspace untouched (same kind)', async () => {
    await runInit({
      noPrompt: true,
      output: sinkOutput(),
      skipKeyStep: true,
      answers: { workspaceName: 'novbase', provider: 'openai' },
    });
    const active = await getActiveWorkspace();
    const before = active!.defaultBaseUrl;

    const out = sinkOutput();
    const manager = createKeyManager({ secretStore: await getBest() });
    await runKeyCli({
      argv: ['set', 'openai', '--key-stdin'],
      manager,
      input: stdinFrom('sk-' + 'B'.repeat(40)),
      output: out,
    });
    const reloaded = await loadWorkspace(active!.id);
    // No --base-url + same kind → workspace.json baseUrl untouched, vault holds the key only.
    expect(reloaded.meta.defaultBaseUrl).toBe(before);
    expect(out.captured).not.toContain('aligned: baseUrl');
    // No kind switch notice either (already openai-compat)
    expect(out.captured).not.toContain('workspace provider:');
  });

  test('anthropic-kind workspace + key set openai (no --base-url) → flips provider to openai-compat', async () => {
    await runInit({
      noPrompt: true,
      output: sinkOutput(),
      skipKeyStep: true,
      answers: { workspaceName: 'flipkind', provider: 'anthropic' },
    });
    const active = await getActiveWorkspace();
    expect(active!.defaultProvider).toBe('anthropic');

    const out = sinkOutput();
    const manager = createKeyManager({ secretStore: await getBest() });
    const code = await runKeyCli({
      argv: ['set', 'openai', '--key-stdin'],
      manager,
      input: stdinFrom('sk-' + 'C'.repeat(40)),
      output: out,
    });
    expect(code).toBe(0);
    const reloaded = await loadWorkspace(active!.id);
    expect(reloaded.meta.defaultProvider).toBe('openai-compat');
    expect(reloaded.meta.defaultModel).toBe('gpt-4o-mini');
    expect(out.captured).toContain('→ workspace provider: anthropic → openai-compat');
  });

  test('openai-compat-kind workspace + key set anthropic (no --base-url) → flips provider to anthropic', async () => {
    await runInit({
      noPrompt: true,
      output: sinkOutput(),
      skipKeyStep: true,
      answers: { workspaceName: 'flipback', provider: 'openai' },
    });
    const active = await getActiveWorkspace();
    expect(active!.defaultProvider).toBe('openai-compat');

    const out = sinkOutput();
    const manager = createKeyManager({ secretStore: await getBest() });
    await runKeyCli({
      argv: ['set', 'anthropic', '--key-stdin'],
      manager,
      input: stdinFrom('sk-ant-' + 'D'.repeat(40)),
      output: out,
    });
    const reloaded = await loadWorkspace(active!.id);
    expect(reloaded.meta.defaultProvider).toBe('anthropic');
    expect(reloaded.meta.defaultModel).toBe('claude-sonnet-4-6');
    expect(out.captured).toContain('→ workspace provider: openai-compat → anthropic');
  });

  test('anthropic-kind workspace + key set groq (no --base-url) → flips to openai-compat with groq defaults', async () => {
    await runInit({
      noPrompt: true,
      output: sinkOutput(),
      skipKeyStep: true,
      answers: { workspaceName: 'groqflip', provider: 'anthropic' },
    });
    const active = await getActiveWorkspace();

    const out = sinkOutput();
    const manager = createKeyManager({ secretStore: await getBest() });
    await runKeyCli({
      argv: ['set', 'groq', '--key-stdin'],
      manager,
      input: stdinFrom('gsk_' + 'E'.repeat(40)),
      output: out,
    });
    const reloaded = await loadWorkspace(active!.id);
    expect(reloaded.meta.defaultProvider).toBe('openai-compat');
    expect(reloaded.meta.defaultModel).toBe('llama-3.3-70b-versatile');
    expect(out.captured).toContain('→ workspace provider: anthropic → openai-compat');
  });

  test('idempotent: re-running same `key set --base-url` does not re-emit kind-switch notice', async () => {
    await runInit({
      noPrompt: true,
      output: sinkOutput(),
      skipKeyStep: true,
      answers: { workspaceName: 'idem', provider: 'anthropic' },
    });

    const manager = createKeyManager({ secretStore: await getBest() });
    const out1 = sinkOutput();
    await runKeyCli({
      argv: ['set', 'openai', '--key-stdin', '--base-url', 'http://localhost:9000/v1'],
      manager,
      input: stdinFrom('local-vllm-any'),
      output: out1,
    });
    expect(out1.captured).toContain('switching workspace');

    const out2 = sinkOutput();
    await runKeyCli({
      argv: ['set', 'openai', '--key-stdin', '--base-url', 'http://localhost:9000/v1'],
      manager,
      input: stdinFrom('local-vllm-any'),
      output: out2,
    });
    expect(out2.captured).not.toContain('switching workspace');
    expect(out2.captured).not.toContain('aligned: baseUrl');
  });

  // Brief refinement #2: same-kind + same-url re-run → workspace.json mtime unchanged.
  test('idempotent: same-kind + same-url re-run does not rewrite workspace.json (no mtime churn)', async () => {
    const { stat } = await import('node:fs/promises');
    const { workspacePathsFor } = await import('../../src/storage/workspaceStore.ts');
    await runInit({
      noPrompt: true,
      output: sinkOutput(),
      skipKeyStep: true,
      answers: { workspaceName: 'nochurn', provider: 'openai' },
    });
    const active = await getActiveWorkspace();
    const paths = await workspacePathsFor(active!.id);
    const metaPath = join(paths.root, 'workspace.json');

    const manager = createKeyManager({ secretStore: await getBest() });

    await runKeyCli({
      argv: ['set', 'openai', '--key-stdin', '--base-url', 'http://litellm:4000/v1'],
      manager,
      input: stdinFrom('proxy-key-1'),
      output: sinkOutput(),
    });
    const mtime1 = (await stat(metaPath)).mtimeMs;

    await new Promise((r) => setTimeout(r, 30));

    const out2 = sinkOutput();
    await runKeyCli({
      argv: ['set', 'openai', '--key-stdin', '--base-url', 'http://litellm:4000/v1'],
      manager,
      input: stdinFrom('proxy-key-2'),
      output: out2,
    });
    const mtime2 = (await stat(metaPath)).mtimeMs;

    expect(mtime2).toBe(mtime1);
    expect(out2.captured).not.toContain('aligned: baseUrl');
  });
});
