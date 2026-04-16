import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import matter from 'gray-matter';
import { runInit, quickInit, __testing } from '../../src/onboard/init.ts';
import { workspacesDir } from '../../src/platform/paths.ts';
import { listWorkspaces, loadWorkspace } from '../../src/storage/workspaceStore.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';

const OVERRIDE = join(tmpdir(), `nimbus-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  await mkdir(OVERRIDE, { recursive: true });
});
afterAll(async () => {
  delete process.env['NIMBUS_HOME'];
  await rm(OVERRIDE, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(workspacesDir(), { recursive: true, force: true }).catch(() => undefined);
});

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

describe('SPEC-901: runInit', () => {
  test('no-prompt mode creates workspace + 6 files + .dreams/', async () => {
    const output = sinkOutput();
    await runInit({
      noPrompt: true,
      output,
      answers: { workspaceName: 'test-ws', primaryUseCase: 'daily assistant' },
    });
    const all = await listWorkspaces();
    const created = all.find((w) => w.name === 'test-ws');
    expect(created).toBeTruthy();
    const { paths } = await loadWorkspace(created!.id);
    const entries = await readdir(paths.root);
    for (const file of ['SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'TOOLS.md', 'DREAMS.md', 'CLAUDE.md']) {
      expect(entries).toContain(file);
    }
    expect(entries).toContain('.dreams');
    const dreamsStat = await stat(join(paths.root, '.dreams'));
    expect(dreamsStat.isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      // 0o700
      expect(dreamsStat.mode & 0o777).toBe(0o700);
    }
    // SOUL.md frontmatter
    const soul = await Bun.file(join(paths.root, 'SOUL.md')).text();
    const parsed = matter(soul);
    expect(parsed.data['schemaVersion']).toBe(1);
    expect(parsed.data['name']).toBe('test-ws');
  });

  test('--location rejects ../etc', () => {
    expect(() => __testing.validateLocation('../etc')).toThrow(NimbusError);
  });

  (process.platform === 'win32' ? test.skip : test)('--location rejects /etc', () => {
    expect(() => __testing.validateLocation('/etc')).toThrow(NimbusError);
  });

  test('second run without --force errors with workspace_exists', async () => {
    const output = sinkOutput();
    await runInit({
      noPrompt: true,
      output,
      answers: { workspaceName: 'dup-ws' },
    });
    let err: unknown = null;
    try {
      await runInit({
        noPrompt: true,
        output: sinkOutput(),
        answers: { workspaceName: 'dup-ws' },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    expect((err as NimbusError).context['reason']).toBe('workspace_exists');
  });

  test('--force overwrites existing workspace files', async () => {
    await runInit({
      noPrompt: true,
      output: sinkOutput(),
      answers: { workspaceName: 'over-ws', primaryUseCase: 'first purpose' },
    });
    await runInit({
      force: true,
      noPrompt: true,
      output: sinkOutput(),
      answers: { workspaceName: 'over-ws', primaryUseCase: 'second purpose' },
    });
    const all = await listWorkspaces();
    const w = all.find((x) => x.name === 'over-ws');
    expect(w).toBeTruthy();
    const { paths } = await loadWorkspace(w!.id);
    const soul = await Bun.file(join(paths.root, 'SOUL.md')).text();
    expect(soul).toContain('second purpose');
  });

  test('resolveModelName picks flagship/budget/workhorse', () => {
    expect(__testing.resolveModelName('anthropic', 'flagship')).toContain('opus');
    expect(__testing.resolveModelName('anthropic', 'budget')).toContain('haiku');
    expect(__testing.resolveModelName('anthropic', 'workhorse')).toContain('sonnet');
    expect(__testing.resolveModelName('ollama', 'workhorse')).toBe('llama3.2');
  });
});

describe('SPEC-901: quickInit — 2-file minimal workspace creation', () => {
  test('creates workspace.json + SOUL.md only (no IDENTITY/MEMORY/TOOLS/DREAMS)', async () => {
    const output = sinkOutput();
    const result = await quickInit(
      { provider: 'anthropic', kind: 'anthropic', defaultModel: 'claude-sonnet-4-6' },
      undefined,
      { output },
    );
    expect(result.name).toBe('personal');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-6');

    const all = await listWorkspaces();
    const created = all.find((w) => w.name === 'personal');
    expect(created).toBeTruthy();

    const { paths } = await loadWorkspace(created!.id);
    const entries = await readdir(paths.root);
    expect(entries).toContain('SOUL.md');
    expect(entries).toContain('workspace.json');
    // Optional files must NOT be written by quickInit
    expect(entries).not.toContain('IDENTITY.md');
    expect(entries).not.toContain('MEMORY.md');
    expect(entries).not.toContain('TOOLS.md');
    expect(entries).not.toContain('DREAMS.md');
    expect(entries).not.toContain('CLAUDE.md');
    expect(entries).not.toContain('.dreams');
  });

  test('SOUL.md has correct schemaVersion and creation date', async () => {
    const output = sinkOutput();
    await quickInit(
      { provider: 'openai', kind: 'openai-compat', defaultModel: 'gpt-4o-mini', defaultEndpoint: 'openai' },
      undefined,
      { output },
    );
    const all = await listWorkspaces();
    const created = all.find((w) => w.name === 'personal');
    expect(created).toBeTruthy();
    const { paths } = await loadWorkspace(created!.id);
    const soul = await Bun.file(paths.soulMd).text();
    const parsed = matter(soul);
    expect(parsed.data['schemaVersion']).toBe(1);
    // gray-matter may parse the ISO date as a Date object or string — either is valid
    expect(parsed.data['created']).toBeDefined();
    expect(soul).toContain('nimbus');
  });

  test('workspace.json reflects openai-compat provider + model for openai key', async () => {
    const output = sinkOutput();
    await quickInit(
      { provider: 'openai', kind: 'openai-compat', defaultModel: 'gpt-4o-mini', defaultEndpoint: 'openai' },
      undefined,
      { output },
    );
    const all = await listWorkspaces();
    const ws = all.find((w) => w.name === 'personal');
    expect(ws!.defaultProvider).toBe('openai-compat');
    expect(ws!.defaultModel).toBe('gpt-4o-mini');
  });

  test('workspace.json reflects groq provider with endpoint + baseUrl', async () => {
    const output = sinkOutput();
    await quickInit(
      {
        provider: 'groq',
        kind: 'openai-compat',
        defaultModel: 'llama-3.3-70b-versatile',
        defaultEndpoint: 'groq',
        defaultBaseUrl: 'https://api.groq.com/openai/v1',
      },
      undefined,
      { output },
    );
    const all = await listWorkspaces();
    const ws = all.find((w) => w.name === 'personal');
    expect(ws!.defaultProvider).toBe('openai-compat');
    expect(ws!.defaultEndpoint).toBe('groq');
    expect(ws!.defaultBaseUrl).toBe('https://api.groq.com/openai/v1');
  });
});

describe('SPEC-901: detectEnvKey', () => {
  test('returns null when no env vars set', () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
      GROQ_API_KEY: process.env['GROQ_API_KEY'],
    };
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['GROQ_API_KEY'];
    const result = __testing.detectEnvKey();
    expect(result).toBeNull();
    // restore
    if (saved.ANTHROPIC_API_KEY) process.env['ANTHROPIC_API_KEY'] = saved.ANTHROPIC_API_KEY;
    if (saved.OPENAI_API_KEY) process.env['OPENAI_API_KEY'] = saved.OPENAI_API_KEY;
    if (saved.GROQ_API_KEY) process.env['GROQ_API_KEY'] = saved.GROQ_API_KEY;
  });

  test('detects ANTHROPIC_API_KEY with highest priority', () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    };
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-testkey';
    process.env['OPENAI_API_KEY'] = 'sk-openaikey';
    const result = __testing.detectEnvKey();
    expect(result).not.toBeNull();
    expect(result!.envVar).toBe('ANTHROPIC_API_KEY');
    expect(result!.key).toBe('sk-ant-testkey');
    // restore
    if (saved.ANTHROPIC_API_KEY) process.env['ANTHROPIC_API_KEY'] = saved.ANTHROPIC_API_KEY;
    else delete process.env['ANTHROPIC_API_KEY'];
    if (saved.OPENAI_API_KEY) process.env['OPENAI_API_KEY'] = saved.OPENAI_API_KEY;
    else delete process.env['OPENAI_API_KEY'];
  });

  test('falls through to OPENAI_API_KEY when ANTHROPIC absent', () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    };
    delete process.env['ANTHROPIC_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-openaifoo';
    const result = __testing.detectEnvKey();
    expect(result!.envVar).toBe('OPENAI_API_KEY');
    // restore
    if (saved.ANTHROPIC_API_KEY) process.env['ANTHROPIC_API_KEY'] = saved.ANTHROPIC_API_KEY;
    else delete process.env['ANTHROPIC_API_KEY'];
    if (saved.OPENAI_API_KEY) process.env['OPENAI_API_KEY'] = saved.OPENAI_API_KEY;
    else delete process.env['OPENAI_API_KEY'];
  });
});
