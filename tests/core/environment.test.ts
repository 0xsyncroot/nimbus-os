import { describe, expect, test } from 'bun:test';
import { serializeEnvironment, snapshotEnvironment } from '../../src/core/environment.ts';

describe('SPEC-109: environment', () => {
  test('snapshotEnvironment returns cwd + nowIso', async () => {
    const snap = await snapshotEnvironment({
      clock: { now: () => 1713182580000 },
      gitProbe: async () => ({}),
      cwd: '/tmp/nimbus-test',
    });
    expect(snap.cwd).toBe('/tmp/nimbus-test');
    expect(snap.nowIso).toContain('2024-04-15');
  });

  test('git probe returning branch populates snapshot', async () => {
    const snap = await snapshotEnvironment({
      gitProbe: async () => ({ branch: 'main', dirty: false }),
      cwd: '/x',
      clock: { now: () => 0 },
    });
    expect(snap.gitBranch).toBe('main');
    expect(snap.gitDirty).toBe(false);
  });

  test('non-git dir leaves git fields undefined', async () => {
    const snap = await snapshotEnvironment({
      gitProbe: async () => ({}),
      cwd: '/x',
      clock: { now: () => 0 },
    });
    expect(snap.gitBranch).toBeUndefined();
    expect(snap.gitDirty).toBeUndefined();
  });

  test('lastFailedToolName propagates', async () => {
    const snap = await snapshotEnvironment({
      gitProbe: async () => ({}),
      cwd: '/x',
      clock: { now: () => 0 },
      lastFailedToolName: 'Bash',
    });
    expect(snap.lastFailedToolName).toBe('Bash');
  });

  test('serialize omits absent fields + escapes xml', () => {
    const out = serializeEnvironment({
      cwd: '/tmp/a&b<c',
      nowIso: '2026-04-15T00:00:00.000Z',
    });
    expect(out).toContain('<cwd>/tmp/a&amp;b&lt;c</cwd>');
    expect(out).not.toContain('<git ');
    expect(out).not.toContain('<lastFailedTool>');
  });

  test('serialize full snapshot', () => {
    const out = serializeEnvironment({
      cwd: '/home/u',
      gitBranch: 'main',
      gitDirty: true,
      nowIso: '2026-04-15T00:00:00.000Z',
      lastFailedToolName: 'Bash',
    });
    expect(out).toContain('<git branch="main" dirty="true"/>');
    expect(out).toContain('<lastFailedTool>Bash</lastFailedTool>');
  });

  test('probe hang aborts within deadline', async () => {
    const start = Date.now();
    const snap = await snapshotEnvironment({
      gitProbe: async (_, timeoutMs, abort) => {
        return await new Promise((resolve) => {
          const t = setTimeout(() => resolve({}), 1000);
          if (abort) abort.addEventListener('abort', () => { clearTimeout(t); resolve({}); });
        });
      },
      cwd: '/x',
      clock: { now: () => 0 },
      abort: AbortSignal.timeout(50),
    });
    expect(snap.gitBranch).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(500);
  });
});
