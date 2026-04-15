import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import matter from 'gray-matter';
import { runInit, __testing } from '../../src/onboard/init.ts';
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

  test('--location rejects /etc', () => {
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
