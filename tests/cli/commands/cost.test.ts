// tests/cli/commands/cost.test.ts — v0.3.3 regression: `nimbus cost` must route
// to the SPEC-701 aggregator, not the old "arrives in v0.2" placeholder.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCost } from '../../../src/cli/commands/cost.ts';
import { __clearAggregatorCache } from '../../../src/cost/aggregator.ts';

const TMP = join(tmpdir(), `nimbus-cost-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const origHome = process.env['NIMBUS_HOME'];

async function withCapturedStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    if (typeof s === 'string') chunks.push(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = orig;
  }
}

async function withCapturedStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array): boolean => {
    if (typeof s === 'string') chunks.push(s);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, err: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = TMP;
  await mkdir(TMP, { recursive: true });
});

afterAll(async () => {
  if (origHome !== undefined) process.env['NIMBUS_HOME'] = origHome;
  else delete process.env['NIMBUS_HOME'];
  await rm(TMP, { recursive: true, force: true });
});

afterEach(() => {
  __clearAggregatorCache();
});

describe('v0.3.3 regression: nimbus cost CLI', () => {
  test('no active workspace → exits 2 with stderr hint, NOT placeholder', async () => {
    const { code, err } = await withCapturedStderr(() => runCost([]));
    expect(code).toBe(2);
    expect(err).toContain('no active workspace');
    // The killer regression: must NOT print the v0.2 placeholder string.
    expect(err).not.toContain('arrives in v0.2');
  });

  test('with workspace + empty ledger → renders "no events", NOT placeholder', async () => {
    // Create a minimal workspace by writing workspace.json + SOUL.md directly;
    // avoids going through the full init flow (which needs a real API key).
    const wsId = '01HPAQKG07T1Q76C3H9WDEBK3Z';
    const wsDir = join(TMP, 'data', 'workspaces', wsId);
    await mkdir(wsDir, { recursive: true });
    await mkdir(join(wsDir, 'sessions'), { recursive: true });
    await mkdir(join(wsDir, 'costs'), { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    const meta = {
      schemaVersion: 1,
      id: wsId,
      name: 'cost-test-ws',
      createdAt: now,
      lastUsed: now,
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      lastBootAt: now,
      numStartups: 1,
    };
    await writeFile(join(wsDir, 'workspace.json'), JSON.stringify(meta, null, 2));
    await writeFile(join(wsDir, 'SOUL.md'), '# SOUL\n');
    // Mark as active via config/config.json (read by core/workspace.ts).
    const configDir = join(TMP, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ activeWorkspace: wsId }));

    const { code, out } = await withCapturedStdout(() => runCost(['--today']));
    expect(code).toBe(0);
    expect(out).toContain('Cost');
    expect(out).toContain('Today');
    expect(out).not.toContain('arrives in v0.2');
  });

  test('--json mode emits valid JSON', async () => {
    // Previous test already created workspace + marked active — reuse.
    const { code, out } = await withCapturedStdout(() => runCost(['--today', '--json']));
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { window: string; by: string; rollup: { totalUsd: number } };
    expect(parsed.window).toBe('today');
    expect(typeof parsed.rollup.totalUsd).toBe('number');
  });
});
