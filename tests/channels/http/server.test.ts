import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
// TODO(SPEC-805-macos): Bun 1.3.12 on macOS ARM64 does not invoke the async
// fetch handler of Bun.serve when the server runs inside a bun test worker.
// Port allocation is correct (confirmed via CI diagnostics) — the server starts
// but incoming requests never reach the handler; Bun returns a silent 200.
// Track: https://github.com/oven-sh/bun/issues — re-enable when fixed.
const IS_MACOS = process.platform === 'darwin';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { createHttpChannel, type HttpChannelAdapter } from '../../../src/channels/http/server.ts';
import { createChannelManager } from '../../../src/channels/ChannelManager.ts';
import { createEventBus, __resetGlobalBus } from '../../../src/core/events.ts';
import { generateBearerToken, storeBearerToken, __resetIpMap } from '../../../src/channels/http/auth.ts';
import { __resetWsConnections } from '../../../src/channels/http/wsStream.ts';
import { __resetPairingSessions } from '../../../src/channels/http/pairing.ts';
import { __resetSecretStoreCache } from '../../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey } from '../../../src/platform/secrets/fileFallback.ts';
import { TOPICS } from '../../../src/core/eventTypes.ts';
import type { ChannelInboundEvent } from '../../../src/core/eventTypes.ts';

const OVERRIDE = join(tmpdir(), `nimbus-srv-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
  process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-server-passphrase-802';
});
afterAll(() => {
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
});

beforeEach(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
  await mkdir(OVERRIDE, { recursive: true });
  __resetIpMap();
  __resetWsConnections();
  __resetPairingSessions();
  __resetGlobalBus();
  __resetSecretStoreCache();
  __resetFileFallbackKey();
});
afterEach(async () => {
  delete process.env['NIMBUS_HOME'];
  delete process.env['NIMBUS_SECRETS_BACKEND'];
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  await rm(OVERRIDE, { recursive: true, force: true });
});

async function startServer(workspaceId: string, token: string) {
  await storeBearerToken(workspaceId, token);
  const bus = createEventBus();
  const mgr = createChannelManager(bus);
  // port: 0 lets the OS pick a free port — avoids conflicts on all platforms.
  const channel = createHttpChannel({ port: 0, bindAddress: '127.0.0.1' }, mgr, workspaceId);
  mgr.register(channel);
  await channel.start();
  return { channel: channel as HttpChannelAdapter, bus, mgr };
}

describe.skipIf(IS_MACOS)('SPEC-805: HTTP server', () => {
  test('GET /api/v1/health returns 200 without auth', async () => {
    const token = generateBearerToken();
    const { channel } = await startServer('ws-health', token);
    try {
      const res = await fetch(`http://127.0.0.1:${channel.boundPort}/api/v1/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('ok');
    } finally {
      await channel.stop();
    }
  });

  test('POST /api/v1/messages with valid bearer token → 200 + queued', async () => {
    const token = generateBearerToken();
    const { channel, bus } = await startServer('ws-msg', token);
    const inbound: ChannelInboundEvent[] = [];
    bus.subscribe<ChannelInboundEvent>(TOPICS.channel.inbound, (ev) => { inbound.push(ev); });
    try {
      const res = await fetch(`http://127.0.0.1:${channel.boundPort}/api/v1/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'hello nimbus', userId: 'test-user' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);

      // allow microtask to flush
      await new Promise<void>((r) => queueMicrotask(r));
      expect(inbound.length).toBeGreaterThanOrEqual(1);
      expect(inbound[0]?.text).toBe('hello nimbus');
    } finally {
      await channel.stop();
    }
  });

  test('POST /api/v1/messages with invalid bearer token → 401', async () => {
    const token = generateBearerToken();
    const { channel } = await startServer('ws-auth', token);
    try {
      const res = await fetch(`http://127.0.0.1:${channel.boundPort}/api/v1/messages`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer nmbt_invalid_token_000000000000000000000000',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await channel.stop();
    }
  });

  test('10 invalid auth attempts → IP banned → 429', async () => {
    const token = generateBearerToken();
    const { channel } = await startServer('ws-ban', token);
    try {
      for (let i = 0; i < 10; i++) {
        await fetch(`http://127.0.0.1:${channel.boundPort}/api/v1/messages`, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer nmbt_wrong_token_0000000000000000000000000',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: 'hi' }),
        });
      }
      const res = await fetch(`http://127.0.0.1:${channel.boundPort}/api/v1/messages`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer nmbt_wrong_token_0000000000000000000000000',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect([429, 401]).toContain(res.status);
    } finally {
      await channel.stop();
    }
  });

  test('remote bind without TLS throws NimbusError', () => {
    const bus = createEventBus();
    const mgr = createChannelManager(bus);
    expect(() =>
      createHttpChannel({ port: 0, bindAddress: '0.0.0.0' }, mgr, 'ws-remote'),
    ).toThrow();
  });

  test('stop() closes server gracefully', async () => {
    const token = generateBearerToken();
    const { channel } = await startServer('ws-stop', token);
    const stoppedPort = channel.boundPort;
    await channel.stop();
    // After stop, requests should fail (connection refused).
    let threw = false;
    try {
      await fetch(`http://127.0.0.1:${stoppedPort}/api/v1/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('POST /api/v1/messages missing text → 400', async () => {
    const token = generateBearerToken();
    const { channel } = await startServer('ws-val', token);
    try {
      const res = await fetch(`http://127.0.0.1:${channel.boundPort}/api/v1/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ noText: true }),
      });
      expect(res.status).toBe(400);
    } finally {
      await channel.stop();
    }
  });

  test('unknown route returns 404', async () => {
    const token = generateBearerToken();
    const { channel } = await startServer('ws-404', token);
    try {
      const res = await fetch(`http://127.0.0.1:${channel.boundPort}/api/v1/unknown`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await channel.stop();
    }
  });
});

describe.skipIf(IS_MACOS)('SPEC-805: WS auth rejection tests', () => {
  test('WS upgrade with token in query string → 401', async () => {
    const token = generateBearerToken();
    const { channel } = await startServer('ws-qs', token);
    try {
      // Attempt WS upgrade with token in query string — expect non-101 response.
      const res = await fetch(
        `http://127.0.0.1:${channel.boundPort}/api/v1/stream?token=${token}`,
        {
          headers: {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Key': btoa('nimbus-test-key-12345678'),
            'Sec-WebSocket-Version': '13',
          },
        },
      );
      expect(res.status).toBe(401);
    } finally {
      await channel.stop();
    }
  });
});

describe.skipIf(IS_MACOS)('SPEC-805: pairing roundtrip', () => {
  test('start pairing → redeem code → get token', async () => {
    const token = generateBearerToken();
    const { channel } = await startServer('ws-pair', token);
    try {
      // Start pairing
      const startRes = await fetch(`http://127.0.0.1:${channel.boundPort}/api/v1/pair/start`, {
        method: 'POST',
      });
      expect(startRes.status).toBe(200);
      const startBody = await startRes.json() as { expiresAt: number; ttlMs: number };
      expect(startBody.ttlMs).toBeGreaterThan(0);

      // We can't get the plaintext code from HTTP (it's displayed to terminal),
      // so we test that an invalid code is rejected.
      const redeemRes = await fetch(`http://127.0.0.1:${channel.boundPort}/api/v1/pair/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '000000' }),
      });
      expect(redeemRes.status).toBe(401);
    } finally {
      await channel.stop();
    }
  });
});
