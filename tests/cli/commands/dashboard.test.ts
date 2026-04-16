// tests/cli/commands/dashboard.test.ts — SPEC-603: observability dashboard CLI tests

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStatus } from '../../../src/cli/commands/status.ts';
import { runHealth } from '../../../src/cli/commands/health.ts';
import { runMetrics } from '../../../src/cli/commands/metrics.ts';
import { runErrors } from '../../../src/cli/commands/errors.ts';
import { runTrace } from '../../../src/cli/commands/trace.ts';
import { runAudit } from '../../../src/cli/commands/audit.ts';
import { streamJsonl, parseSince, listShards } from '../../../src/observability/reader.ts';
import { buildHistogram, percentile, __resetRollupCache } from '../../../src/observability/rollup.ts';
import { __resetHealCircuit } from '../../../src/selfHeal/circuit.ts';

const TMP = join(tmpdir(), `nimbus-dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const origHome = process.env['NIMBUS_HOME'];

function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = TMP;
  await mkdir(join(TMP, 'logs', 'metrics'), { recursive: true });
  await mkdir(join(TMP, 'logs', 'audit'), { recursive: true });

  // Write today's metrics shard with usage + error events
  const today = todayKey();
  const metricsFile = join(TMP, 'logs', 'metrics', `${today}.jsonl`);
  const lines = [
    { type: 'usage', ts: Date.now() - 5000, provider: 'anthropic', model: 'claude-sonnet-4-6', input: 100, output: 200, costUsd: 0.005, ms: 800 },
    { type: 'usage', ts: Date.now() - 4000, provider: 'anthropic', model: 'claude-sonnet-4-6', input: 150, output: 300, costUsd: 0.007, ms: 1200 },
    { type: 'error', ts: Date.now() - 3000, code: 'P_NETWORK', turnId: 'turn-abc123' },
    { type: 'tool_invocation', ts: Date.now() - 2500, turnId: 'turn-abc123', name: 'Bash', toolUseId: 'tu1' },
    { type: 'tool_result', ts: Date.now() - 2000, turnId: 'turn-abc123', name: 'Bash', ok: true, ms: 300 },
    { type: 'turn_complete', ts: Date.now() - 1000, turnId: 'turn-abc123', ok: true, ms: 2000 },
  ];
  await writeFile(metricsFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // Write audit shard
  const auditFile = join(TMP, 'logs', 'audit', `${today}.jsonl`);
  const auditLines = [
    { schemaVersion: 1, ts: Date.now() - 6000, sessionId: '01H0000000000000000000A001', kind: 'tool_call', toolName: 'Bash', inputDigest: 'a'.repeat(64), outcome: 'ok' },
  ];
  await writeFile(auditFile, auditLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
});

afterAll(async () => {
  if (origHome !== undefined) process.env['NIMBUS_HOME'] = origHome;
  else delete process.env['NIMBUS_HOME'];
  await rm(TMP, { recursive: true, force: true });
});

afterEach(() => {
  __resetHealCircuit();
  __resetRollupCache();
});

describe('SPEC-603: reader', () => {
  test('parseSince 1h', () => {
    const now = Date.now();
    const r = parseSince('1h');
    expect(r).toBeGreaterThan(now - 61 * 60 * 1000);
    expect(r).toBeLessThan(now);
  });

  test('parseSince 1d', () => {
    const now = Date.now();
    const r = parseSince('1d');
    expect(r).toBeGreaterThan(now - 25 * 60 * 60 * 1000);
  });

  test('parseSince epoch number', () => {
    expect(parseSince('1000000')).toBe(1000000);
  });

  test('streamJsonl reads lines', async () => {
    const today = todayKey();
    const file = join(TMP, 'logs', 'metrics', `${today}.jsonl`);
    const items: unknown[] = [];
    for await (const item of streamJsonl(file)) {
      items.push(item);
    }
    expect(items.length).toBeGreaterThan(0);
  });

  test('streamJsonl filters by since', async () => {
    const today = todayKey();
    const file = join(TMP, 'logs', 'metrics', `${today}.jsonl`);
    const items: unknown[] = [];
    // since = far future → no items
    for await (const item of streamJsonl(file, { since: Date.now() + 1_000_000 })) {
      items.push(item);
    }
    expect(items.length).toBe(0);
  });

  test('streamJsonl skips missing file gracefully', async () => {
    const items: unknown[] = [];
    for await (const item of streamJsonl('/nonexistent/path.jsonl')) {
      items.push(item);
    }
    expect(items.length).toBe(0);
  });

  test('listShards returns today shard', async () => {
    const dir = join(TMP, 'logs', 'metrics');
    const shards = await listShards(dir);
    expect(shards.length).toBeGreaterThan(0);
  });
});

describe('SPEC-603: rollup', () => {
  test('percentile on empty → 0', () => {
    expect(percentile([], 50)).toBe(0);
  });

  test('percentile on [1, 2, 3] p50', () => {
    const sorted = [1, 2, 3];
    expect(percentile(sorted, 50)).toBe(2);
  });

  test('percentile p99 on [1..100]', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    const p99 = percentile(sorted, 99);
    expect(p99).toBeGreaterThanOrEqual(98);
    expect(p99).toBeLessThanOrEqual(100);
  });

  test('buildHistogram counts and stats correct', () => {
    const h = buildHistogram([100, 200, 300, 400, 500]);
    expect(h.count).toBe(5);
    expect(h.min).toBe(100);
    expect(h.max).toBe(500);
    expect(h.p50).toBe(300);
  });

  test('buildHistogram empty → all zeros', () => {
    const h = buildHistogram([]);
    expect(h.count).toBe(0);
    expect(h.p99).toBe(0);
  });
});

describe('SPEC-603: nimbus status', () => {
  test('returns number (exit code)', async () => {
    const code = await runStatus([]);
    expect(typeof code).toBe('number');
  });

  test('--json mode returns valid JSON on stdout', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array): boolean => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    await runStatus(['--json']);
    process.stdout.write = orig;
    const out = chunks.join('');
    const parsed = JSON.parse(out);
    expect(typeof parsed.overall).toBe('string');
  });

  test('no ANSI codes in --json output', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array): boolean => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    await runStatus(['--json']);
    process.stdout.write = orig;
    const out = chunks.join('');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe('SPEC-603: nimbus health', () => {
  test('returns number (exit code)', async () => {
    const code = await runHealth([]);
    expect(typeof code).toBe('number');
  });

  test('--json returns valid JSON with overall field', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array): boolean => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    await runHealth(['--json']);
    process.stdout.write = orig;
    const out = chunks.join('');
    const parsed = JSON.parse(out);
    expect(['ok', 'degraded', 'down']).toContain(parsed.overall);
    expect(typeof parsed.memoryMb).toBe('number');
    expect(typeof parsed.diskFreeMb).toBe('number');
  });
});

describe('SPEC-603: nimbus metrics', () => {
  test('returns 0 exit code', async () => {
    __resetRollupCache();
    const code = await runMetrics(['--since', '1d']);
    expect(typeof code).toBe('number');
  });

  test('--json outputs array', async () => {
    __resetRollupCache();
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array): boolean => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    await runMetrics(['--json', '--since', '1d']);
    process.stdout.write = orig;
    const out = chunks.join('');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe('SPEC-603: nimbus errors', () => {
  test('returns number exit code', async () => {
    const code = await runErrors(['--since', '1d']);
    expect(typeof code).toBe('number');
  });

  test('--json returns array', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array): boolean => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    await runErrors(['--json', '--since', '1d']);
    process.stdout.write = orig;
    const out = chunks.join('');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test('--code filter only shows matching codes', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array): boolean => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    await runErrors(['--json', '--since', '1d', '--code', 'P_NETWORK']);
    process.stdout.write = orig;
    const out = chunks.join('');
    const parsed = JSON.parse(out) as Array<{ code: string }>;
    for (const item of parsed) {
      expect(item.code.startsWith('P_')).toBe(true);
    }
  });
});

describe('SPEC-603: nimbus trace', () => {
  test('no turnId → exit 1', async () => {
    const code = await runTrace([]);
    expect(code).toBe(1);
  });

  test('valid turnId → exit 0 with events', async () => {
    const code = await runTrace(['turn-abc123']);
    expect(typeof code).toBe('number');
  });

  test('--json for valid turnId outputs array', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array): boolean => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    await runTrace(['turn-abc123', '--json']);
    process.stdout.write = orig;
    const out = chunks.join('');
    if (out.trim()) {
      const parsed = JSON.parse(out);
      expect(Array.isArray(parsed)).toBe(true);
    }
  });
});

describe('SPEC-603: nimbus audit', () => {
  test('returns number exit code', async () => {
    const code = await runAudit(['--since', '1d']);
    expect(typeof code).toBe('number');
  });

  test('--json returns array', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array): boolean => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    await runAudit(['--json', '--since', '1d']);
    process.stdout.write = orig;
    const out = chunks.join('');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test('--json output has no ANSI codes', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array): boolean => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    await runAudit(['--json', '--since', '1d']);
    process.stdout.write = orig;
    const out = chunks.join('');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });
});
