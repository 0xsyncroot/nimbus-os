// server.ts — SPEC-805 loopback RPC adapter.
// Binds exclusively to 127.0.0.1 (refuses remote bind).
// Routes: POST /api/v1/messages, GET /api/v1/health
// Auth: bearer token (nmbt_<base64url>) per workspace, stored in SPEC-152 vault.

import { createServer as netCreateServer } from 'node:net';
import type { Server } from 'bun';
import type { ChannelAdapter } from '../ChannelAdapter.ts';
import type { ChannelManager } from '../ChannelManager.ts';
import { verifyBearer, loadBearerToken, maskToken } from './auth.ts';
import { logger } from '../../observability/logger.ts';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';

export interface HttpChannelConfig {
  port?: number;
  bindAddress?: string;
}

/** Extended adapter returned by createHttpChannel — exposes the OS-assigned port.
 *  Use boundPort (not the config port) when port: 0 is passed. */
export interface HttpChannelAdapter extends ChannelAdapter {
  readonly boundPort: number;
}

const DEFAULT_PORT = 7432;
const DEFAULT_BIND = '127.0.0.1';
const LOOPBACK_ADDRS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Ask the OS for a free port by binding a net server to port 0, recording the
 * assigned port, and immediately closing it.  Used when cfg.port === 0 so we
 * can pass a concrete port to Bun.serve and avoid the macOS bug where
 * `server.port` / `server.url.port` still report 0 after `port: 0` binding.
 */
function pickFreePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.listen(0, hostname, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function requireBearer(req: Request, workspaceId: string): Promise<Response | null> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401);
  }
  const token = auth.slice('Bearer '.length).trim();
  const valid = await verifyBearer(token, workspaceId);
  if (!valid) {
    logger.warn({ token: maskToken(token), workspaceId }, 'http auth rejected');
    return jsonResponse({ error: 'Invalid bearer token' }, 401);
  }
  return null; // auth OK
}

export function createHttpChannel(
  cfg: HttpChannelConfig,
  channelManager: ChannelManager,
  workspaceId: string,
): HttpChannelAdapter {
  const port = cfg.port ?? DEFAULT_PORT;
  const bind = cfg.bindAddress ?? DEFAULT_BIND;

  if (!LOOPBACK_ADDRS.has(bind)) {
    throw new NimbusError(ErrorCode.X_NETWORK_BLOCKED, {
      reason: 'remote_bind_not_allowed',
      bind,
      note: 'nimbus HTTP channel is loopback-only; remote access out-of-scope until v0.4+',
    });
  }

  let boundPort = port;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: Server<any> | null = null;

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check — no auth required.
    if (req.method === 'GET' && path === '/api/v1/health') {
      return jsonResponse({ status: 'ok', workspaceId, ts: Date.now() });
    }

    // Authenticated routes.
    const authErr = await requireBearer(req, workspaceId);
    if (authErr) return authErr;

    // POST /api/v1/messages — send a message, receive acknowledgement JSON.
    if (req.method === 'POST' && path === '/api/v1/messages') {
      let body: { text?: unknown; userId?: unknown };
      try {
        body = (await req.json()) as { text?: unknown; userId?: unknown };
      } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400);
      }
      if (typeof body.text !== 'string' || !body.text.trim()) {
        return jsonResponse({ error: 'text required' }, 400);
      }
      const userId = typeof body.userId === 'string' ? body.userId : 'http-user';
      channelManager.publishInbound({
        adapterId: 'http',
        workspaceId,
        userId,
        text: body.text,
        raw: body,
      });
      return jsonResponse({ ok: true, queued: true });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }

  async function start(): Promise<void> {
    // When port === 0 (ephemeral, used in tests), pre-allocate via node:net to
    // work around a Bun/macOS bug where Bun.serve({ port: 0 }).port stays 0.
    const listenPort = port === 0 ? await pickFreePort(bind) : port;

    server = Bun.serve({
      hostname: bind,
      port: listenPort,
      fetch: handleRequest,
    });

    // Capture the actual bound port.  Prefer server.port / server.url.port when
    // they are non-zero (works on Linux); fall back to the pre-allocated port.
    const rawPort = server.port ?? 0;
    const urlPort = server.url ? parseInt(server.url.port, 10) : NaN;
    boundPort =
      (rawPort > 0 ? rawPort : null) ??
      (Number.isFinite(urlPort) && urlPort > 0 ? urlPort : null) ??
      listenPort;
    logger.info({ bind, port: boundPort }, 'HTTP channel started');
  }

  async function stop(): Promise<void> {
    if (server) {
      await server.stop(true);
    }
    server = null;
    logger.info({ bind, port: boundPort }, 'HTTP channel stopped');
  }

  async function send(_wid: string, _text: string): Promise<void> {
    // HTTP channel is request/response only; outbound push not supported.
    logger.debug({ workspaceId }, 'http channel send() is a no-op (loopback RPC only)');
  }

  return {
    id: 'http',
    kind: 'http',
    nativeFormat: 'markdown',
    capabilities: { nativeFormat: 'markdown' },
    get boundPort() { return boundPort; },
    start,
    stop,
    send,
  };
}

// Exported for test-only: verify a bearer token is stored for a workspace.
export { loadBearerToken };
