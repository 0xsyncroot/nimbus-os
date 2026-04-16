// tests/mcp/mcpClient.test.ts — SPEC-306: Config schema, security, and backoff unit tests.
// Note: mcpClient.ts / transports.ts / serverLifecycle.ts are NOT imported here because
// they depend on @modelcontextprotocol/sdk. Those modules are exercised in e2e tests after
// `bun install` makes the SDK available. This file covers the pure (no-SDK) modules.

import { describe, expect, test } from 'bun:test';
import {
  McpServerConfig,
  McpStdioConfig,
  McpHttpConfig,
  expandEnvVars,
  expandEnvRecord,
  expandConfigEnv,
  mergeMcpConfigs,
} from '../../src/mcp/mcpConfig.ts';
import {
  sanitizeSubprocessEnv,
  capToolOutput,
  MAX_TOOL_OUTPUT_BYTES,
} from '../../src/mcp/mcpSecurity.ts';
import {
  computeBackoffDelay,
  withBackoff,
  DEFAULT_BACKOFF,
} from '../../src/mcp/backoff.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';

// ---- Config schema: accept valid stdio/http ---------------------------------

describe('SPEC-306: McpServerConfig schema', () => {
  test('accepts valid stdio config (minimal)', () => {
    const result = McpStdioConfig.safeParse({ type: 'stdio', command: 'node' });
    expect(result.success).toBe(true);
  });

  test('accepts valid stdio config (full)', () => {
    const result = McpStdioConfig.safeParse({
      type: 'stdio',
      command: 'node',
      args: ['server.js', '--port', '3000'],
      env: { MY_KEY: 'value' },
      timeout: 120_000,
    });
    expect(result.success).toBe(true);
  });

  test('accepts valid http config (minimal)', () => {
    const result = McpHttpConfig.safeParse({
      type: 'http',
      url: 'https://example.com/mcp',
    });
    expect(result.success).toBe(true);
  });

  test('accepts valid http config (full)', () => {
    const result = McpHttpConfig.safeParse({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer tok123' },
      timeout: 45_000,
    });
    expect(result.success).toBe(true);
  });

  test('rejects stdio with empty command', () => {
    const result = McpStdioConfig.safeParse({ type: 'stdio', command: '' });
    expect(result.success).toBe(false);
  });

  test('rejects stdio missing command', () => {
    const result = McpStdioConfig.safeParse({ type: 'stdio' });
    expect(result.success).toBe(false);
  });

  test('rejects http with non-URL', () => {
    const result = McpHttpConfig.safeParse({ type: 'http', url: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  test('rejects http missing url', () => {
    const result = McpHttpConfig.safeParse({ type: 'http' });
    expect(result.success).toBe(false);
  });

  test('discriminated union: rejects unknown type', () => {
    const result = McpServerConfig.safeParse({ type: 'ws', url: 'ws://x' });
    expect(result.success).toBe(false);
  });
});

// ---- Env var expansion -------------------------------------------------------

describe('SPEC-306: env var expansion', () => {
  const env: Record<string, string | undefined> = {
    HOME: '/home/user',
    MY_TOKEN: 'abc123',
    MISSING: undefined,
  };

  test('expands ${VAR} with value from env', () => {
    expect(expandEnvVars('${HOME}/dir', env)).toBe('/home/user/dir');
  });

  test('expands multiple vars', () => {
    expect(expandEnvVars('${HOME}:${MY_TOKEN}', env)).toBe('/home/user:abc123');
  });

  test('expands missing var to empty string', () => {
    expect(expandEnvVars('prefix${MISSING}suffix', env)).toBe('prefixsuffix');
  });

  test('no-op when no vars present', () => {
    expect(expandEnvVars('static-value', env)).toBe('static-value');
  });

  test('expandEnvRecord applies expansion to all values', () => {
    const rec = { A: '${HOME}/a', B: 'static' };
    const result = expandEnvRecord(rec, env);
    expect(result['A']).toBe('/home/user/a');
    expect(result['B']).toBe('static');
  });

  test('expandConfigEnv expands stdio command + args + env', () => {
    const cfg = McpStdioConfig.parse({
      type: 'stdio',
      command: '${HOME}/bin/server',
      args: ['--data', '${HOME}/data'],
      env: { EXTRA: '${MY_TOKEN}' },
    });
    const expanded = expandConfigEnv(cfg, env);
    expect(expanded.type).toBe('stdio');
    if (expanded.type === 'stdio') {
      expect(expanded.command).toBe('/home/user/bin/server');
      expect(expanded.args).toEqual(['--data', '/home/user/data']);
      expect(expanded.env?.['EXTRA']).toBe('abc123');
    }
  });

  test('expandConfigEnv expands http url + headers', () => {
    const cfg = McpHttpConfig.parse({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${MY_TOKEN}' },
    });
    const expanded = expandConfigEnv(cfg, env);
    expect(expanded.type).toBe('http');
    if (expanded.type === 'http') {
      expect(expanded.headers?.['Authorization']).toBe('Bearer abc123');
    }
  });
});

// ---- Config merge -------------------------------------------------------------

describe('SPEC-306: config merge', () => {
  test('project-scope overrides user-scope on name collision', () => {
    const user = { server1: McpStdioConfig.parse({ type: 'stdio', command: 'user-cmd' }) };
    const project = { server1: McpStdioConfig.parse({ type: 'stdio', command: 'project-cmd' }) };
    const merged = mergeMcpConfigs(user, project);
    expect(merged['server1']?.type).toBe('stdio');
    if (merged['server1']?.type === 'stdio') {
      expect(merged['server1'].command).toBe('project-cmd');
    }
  });

  test('merge combines non-overlapping servers', () => {
    const user = { a: McpStdioConfig.parse({ type: 'stdio', command: 'a' }) };
    const project = { b: McpStdioConfig.parse({ type: 'stdio', command: 'b' }) };
    const merged = mergeMcpConfigs(user, project);
    expect(Object.keys(merged)).toContain('a');
    expect(Object.keys(merged)).toContain('b');
  });
});

// ---- Security: env sanitization ----------------------------------------------

describe('SPEC-306: env sanitization', () => {
  test('strips *_API_KEY keys', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-...', OPENAI_API_KEY: 'sk-...', PATH: '/usr/bin' };
    const clean = sanitizeSubprocessEnv(env);
    expect('ANTHROPIC_API_KEY' in clean).toBe(false);
    expect('OPENAI_API_KEY' in clean).toBe(false);
    expect(clean['PATH']).toBe('/usr/bin');
  });

  test('strips *_TOKEN keys', () => {
    const env = { GH_TOKEN: 'ghp_xxx', NIMBUS_KEY: 'nope', SOME_TOKEN: 'secret' };
    const clean = sanitizeSubprocessEnv(env);
    expect('GH_TOKEN' in clean).toBe(false);
    expect('SOME_TOKEN' in clean).toBe(false);
  });

  test('strips *_SECRET keys', () => {
    const env = { DB_SECRET: 'supersecret', NOT_A_SECRET_VAR: 'keep' };
    const clean = sanitizeSubprocessEnv(env);
    expect('DB_SECRET' in clean).toBe(false);
    expect(clean['NOT_A_SECRET_VAR']).toBe('keep');
  });

  test('strips NIMBUS_VAULT_PASSPHRASE', () => {
    const env = { NIMBUS_VAULT_PASSPHRASE: 'p@ss', OTHER: 'ok' };
    const clean = sanitizeSubprocessEnv(env);
    expect('NIMBUS_VAULT_PASSPHRASE' in clean).toBe(false);
    expect(clean['OTHER']).toBe('ok');
  });

  test('preserves non-secret env vars', () => {
    const env = { HOME: '/home/user', PATH: '/usr/bin', TERM: 'xterm-256color' };
    const clean = sanitizeSubprocessEnv(env);
    expect(clean).toMatchObject(env);
  });

  test('returns new object (does not mutate input)', () => {
    const env = { ANTHROPIC_API_KEY: 'sk', PATH: '/usr/bin' };
    const clean = sanitizeSubprocessEnv(env);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk');
    expect('ANTHROPIC_API_KEY' in clean).toBe(false);
  });
});

// ---- Security: tool output cap -----------------------------------------------

describe('SPEC-306: tool output cap', () => {
  test('output within 100KB passes through unchanged', () => {
    const output = 'a'.repeat(1000);
    expect(capToolOutput(output)).toBe(output);
  });

  test('output exceeding 100KB is truncated with banner', () => {
    const bigOutput = 'x'.repeat(MAX_TOOL_OUTPUT_BYTES + 500);
    const result = capToolOutput(bigOutput);
    expect(result).toContain('[MCP output truncated');
    const encoded = new TextEncoder().encode(result);
    expect(encoded.length).toBeLessThan(MAX_TOOL_OUTPUT_BYTES + 200);
  });

  test('output exactly at limit passes through', () => {
    const output = 'a'.repeat(MAX_TOOL_OUTPUT_BYTES);
    expect(capToolOutput(output)).toBe(output);
  });
});

// ---- Backoff: pure logic -----------------------------------------------------

describe('SPEC-306: exponential backoff', () => {
  test('DEFAULT_BACKOFF constants are correct', () => {
    expect(DEFAULT_BACKOFF.baseMs).toBe(1_000);
    expect(DEFAULT_BACKOFF.maxMs).toBe(30_000);
    expect(DEFAULT_BACKOFF.maxAttempts).toBe(5);
  });

  test('computeBackoffDelay: attempt 0 = baseMs', () => {
    expect(computeBackoffDelay(0, DEFAULT_BACKOFF)).toBe(1_000);
  });

  test('computeBackoffDelay: attempt 1 = 2s', () => {
    expect(computeBackoffDelay(1, DEFAULT_BACKOFF)).toBe(2_000);
  });

  test('computeBackoffDelay: attempt 2 = 4s', () => {
    expect(computeBackoffDelay(2, DEFAULT_BACKOFF)).toBe(4_000);
  });

  test('computeBackoffDelay: capped at maxMs', () => {
    expect(computeBackoffDelay(10, DEFAULT_BACKOFF)).toBe(30_000);
  });

  test('all attempt delays are within bounds', () => {
    for (let i = 0; i < DEFAULT_BACKOFF.maxAttempts; i++) {
      const delay = computeBackoffDelay(i, DEFAULT_BACKOFF);
      expect(delay).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.baseMs);
      expect(delay).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
    }
  });

  test('withBackoff: succeeds on first try', async () => {
    const result = await withBackoff(async () => 42, DEFAULT_BACKOFF, async () => {});
    expect(result).toBe(42);
  });

  test('withBackoff: succeeds on retry after failures', async () => {
    let attempt = 0;
    const result = await withBackoff(
      async () => {
        attempt++;
        if (attempt < 3) throw new Error('fail');
        return 'ok';
      },
      DEFAULT_BACKOFF,
      async () => {},
    );
    expect(result).toBe('ok');
    expect(attempt).toBe(3);
  });

  test('withBackoff: throws last error after max attempts', async () => {
    const sleepDelays: number[] = [];
    let thrown: Error | null = null;

    try {
      await withBackoff(
        async () => { throw new Error('always fail'); },
        DEFAULT_BACKOFF,
        async (ms) => { sleepDelays.push(ms); },
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toBe('always fail');
    // sleep called maxAttempts - 1 times
    expect(sleepDelays.length).toBe(DEFAULT_BACKOFF.maxAttempts - 1);
  });

  test('withBackoff: onRetry callback receives attempt + delay + error', async () => {
    const retries: Array<{ attempt: number; delayMs: number; err: string }> = [];

    try {
      await withBackoff(
        async () => { throw new Error('boom'); },
        { baseMs: 100, maxMs: 5_000, maxAttempts: 3 },
        async () => {},
        (attempt, delayMs, err) => {
          retries.push({ attempt, delayMs, err: err.message });
        },
      );
    } catch {}

    expect(retries.length).toBe(2); // 3 attempts → 2 retries
    expect(retries[0]!.attempt).toBe(0);
    expect(retries[0]!.err).toBe('boom');
    expect(retries[1]!.attempt).toBe(1);
    expect(retries[1]!.delayMs).toBe(200); // 100 * 2^1
  });
});
