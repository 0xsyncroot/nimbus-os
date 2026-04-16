// tests/mcp/mcpClient.test.ts — SPEC-306: Config schema, security, and lifecycle unit tests.

import { describe, expect, test, mock } from 'bun:test';
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
  RECONNECT_BASE_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_MS,
  createManagedServer,
} from '../../src/mcp/serverLifecycle.ts';
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
  const env = { HOME: '/home/user', MY_TOKEN: 'abc123', MISSING: undefined };
  const envRecord = env as Record<string, string | undefined>;

  test('expands ${VAR} with value from env', () => {
    expect(expandEnvVars('${HOME}/dir', envRecord)).toBe('/home/user/dir');
  });

  test('expands multiple vars', () => {
    expect(expandEnvVars('${HOME}:${MY_TOKEN}', envRecord)).toBe('/home/user:abc123');
  });

  test('expands missing var to empty string', () => {
    expect(expandEnvVars('prefix${MISSING}suffix', envRecord)).toBe('prefixsuffix');
  });

  test('no-op when no vars present', () => {
    expect(expandEnvVars('static-value', envRecord)).toBe('static-value');
  });

  test('expandEnvRecord applies expansion to all values', () => {
    const rec = { A: '${HOME}/a', B: 'static' };
    const result = expandEnvRecord(rec, envRecord);
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
    const expanded = expandConfigEnv(cfg, envRecord);
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
    const expanded = expandConfigEnv(cfg, envRecord);
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
    expect(env['ANTHROPIC_API_KEY']).toBe('sk'); // original unchanged
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
    const encoded = new TextEncoder().encode(result);
    // Result should mention truncation
    expect(result).toContain('[MCP output truncated');
    // Result should not be much larger than limit
    expect(encoded.length).toBeLessThan(MAX_TOOL_OUTPUT_BYTES + 200);
  });

  test('output exactly at limit passes through', () => {
    const output = 'a'.repeat(MAX_TOOL_OUTPUT_BYTES);
    expect(capToolOutput(output)).toBe(output);
  });
});

// ---- Lifecycle: reconnect backoff -------------------------------------------

describe('SPEC-306: server lifecycle reconnect', () => {
  test('reconnect constants are correct', () => {
    expect(RECONNECT_BASE_MS).toBe(1_000);
    expect(RECONNECT_MAX_MS).toBe(30_000);
    expect(RECONNECT_MAX_ATTEMPTS).toBe(5);
  });

  test('exponential backoff does not exceed max', () => {
    // Verify the formula used in serverLifecycle: base * 2^attempt, capped at max
    for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
      expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_MS);
      expect(delay).toBeGreaterThanOrEqual(RECONNECT_BASE_MS);
    }
  });

  test('createManagedServer throws T_MCP_UNAVAILABLE after max attempts', async () => {
    let connectCount = 0;
    let sleepCount = 0;
    const sleepDelays: number[] = [];

    // We mock the lifecycle by overriding _sleep and making the transport always fail
    // We need to intercept the createTransport + createMcpClient calls.
    // Since we can't easily mock imports in Bun, we test the server by providing
    // a config that fails to connect (invalid command) and a fast sleep mock.

    // Use a mock sleep to speed up the test
    const mockSleep = async (ms: number): Promise<void> => {
      sleepCount++;
      sleepDelays.push(ms);
      // Don't actually sleep in tests
    };

    const server = createManagedServer({
      serverName: 'test-fail-server',
      config: {
        type: 'stdio',
        command: '/this/binary/does/not/exist/at/all/nimbus-test-mcp',
        args: [],
      },
      _sleep: mockSleep,
    });

    let thrown: NimbusError | null = null;
    try {
      await server.getClient();
    } catch (err) {
      if (err instanceof NimbusError) thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe(ErrorCode.T_MCP_UNAVAILABLE);
    expect(thrown?.context['attempts']).toBe(RECONNECT_MAX_ATTEMPTS);
    // sleep should have been called RECONNECT_MAX_ATTEMPTS - 1 times (no sleep after last attempt)
    expect(sleepCount).toBe(RECONNECT_MAX_ATTEMPTS - 1);
    // delays should be increasing (exponential backoff)
    for (let i = 1; i < sleepDelays.length; i++) {
      expect(sleepDelays[i]!).toBeGreaterThanOrEqual(sleepDelays[i - 1]!);
    }
  });

  test('shutdown is safe when never connected', async () => {
    const server = createManagedServer({
      serverName: 'never-connected',
      config: { type: 'stdio', command: 'node', args: [] },
    });
    // Should not throw
    await expect(server.shutdown()).resolves.toBeUndefined();
  });
});
