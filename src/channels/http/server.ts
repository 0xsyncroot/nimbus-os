// server.ts — SPEC-805 T4: Bun.serve HTTP + WebSocket channel adapter.
// Default bind: 127.0.0.1:7432. Remote bind requires TLS config.
// Routes: POST /api/v1/messages, GET /api/v1/health, WS /api/v1/stream
// POST /api/v1/pair/start, POST /api/v1/pair/redeem

import { createServer as netCreateServer } from 'node:net';
import type { Server, ServerWebSocket } from 'bun';
import type { ChannelAdapter } from '../ChannelAdapter.ts';
import type { ChannelManager } from '../ChannelManager.ts';
import {
  verifyBearer,
  isIpBanned,
  recordFailedAuth,
  loadBearerToken,
  maskToken,
} from './auth.ts';
import {
  handleWsOpen,
  handleWsClose,
  handleWsMessage,
  validateWsUpgrade,
  closeAllWsConnections,
  type WsData,
} from './wsStream.ts';
import { createPairingSession, redeemPairingCode, renderPairingQr } from './pairing.ts';
import { logger } from '../../observability/logger.ts';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';

export interface HttpChannelConfig {
  port?: number;
  bindAddress?: string;
  tlsCert?: string;
  tlsKey?: string;
  trustedProxy?: boolean;
}

/** Extended adapter returned by createHttpChannel — exposes the OS-assigned port.
 *  Use boundPort (not the config port) when port: 0 is passed. */
export interface HttpChannelAdapter extends ChannelAdapter {
  readonly boundPort: number;
}

const DEFAULT_PORT = 7432;
const DEFAULT_BIND = '127.0.0.1';

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

function extractIp(req: Request, trustedProxy: boolean): string {
  if (trustedProxy) {
    const xff = req.headers.get('X-Forwarded-For');
    if (xff) return xff.split(',')[0]?.trim() ?? '0.0.0.0';
  }
  return req.headers.get('X-Real-IP') ?? '0.0.0.0';
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function requireBearer(
  req: Request,
  ip: string,
  workspaceId: string,
): Promise<Response | null> {
  if (isIpBanned(ip)) {
    return jsonResponse({ error: 'IP banned' }, 429);
  }
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401);
  }
  const token = auth.slice('Bearer '.length).trim();
  const valid = await verifyBearer(token, workspaceId);
  if (!valid) {
    const { banned } = recordFailedAuth(ip);
    logger.warn({ ip, token: maskToken(token), workspaceId }, 'http auth rejected');
    return banned
      ? jsonResponse({ error: 'IP banned due to excessive failures' }, 429)
      : jsonResponse({ error: 'Invalid bearer token' }, 401);
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
  let boundPort = port;
  const isRemote = bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1';

  if (isRemote && (!cfg.tlsCert || !cfg.tlsKey)) {
    throw new NimbusError(ErrorCode.X_NETWORK_BLOCKED, {
      reason: 'remote_bind_requires_tls',
      bind,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: Server<any> | null = null;

  async function resolveWorkspaceForToken(token: string): Promise<string | null> {
    const ok = await verifyBearer(token, workspaceId);
    return ok ? workspaceId : null;
  }

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const ip = extractIp(req, cfg.trustedProxy ?? false);
    const path = url.pathname;

    // Health check — no auth required.
    if (req.method === 'GET' && path === '/api/v1/health') {
      return jsonResponse({ status: 'ok', workspaceId, ts: Date.now() });
    }

    // Pairing endpoints — no auth required.
    if (req.method === 'POST' && path === '/api/v1/pair/start') {
      const session = await createPairingSession(workspaceId);
      renderPairingQr(session.code, port);
      return jsonResponse({ expiresAt: session.expiresAt, ttlMs: session.expiresAt - Date.now() });
    }

    if (req.method === 'POST' && path === '/api/v1/pair/redeem') {
      let body: { code?: unknown };
      try {
        body = (await req.json()) as { code?: unknown };
      } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400);
      }
      if (typeof body.code !== 'string') {
        return jsonResponse({ error: 'code required' }, 400);
      }
      const token = await redeemPairingCode(body.code);
      if (!token) {
        return jsonResponse({ error: 'Invalid or expired pairing code' }, 401);
      }
      return jsonResponse({ token: maskToken(token), workspaceId });
    }

    // Authenticated routes.
    const authErr = await requireBearer(req, ip, workspaceId);
    if (authErr) return authErr;

    // POST /api/v1/messages — send a message, receive full response JSON.
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

    // GET /api/v1/cost — placeholder for v0.3.
    if (req.method === 'GET' && path === '/api/v1/cost') {
      return jsonResponse({ cost: null, note: 'cost tracking available in v0.3.1' });
    }

    // GET /api/v1/sessions — placeholder.
    if (req.method === 'GET' && path === '/api/v1/sessions') {
      return jsonResponse({ sessions: [] });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }

  const wsHandlers = {
    open(ws: ServerWebSocket<WsData>) {
      handleWsOpen(ws);
    },
    close(ws: ServerWebSocket<WsData>) {
      handleWsClose(ws);
    },
    message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
      handleWsMessage(ws, message);
      // Forward inbound WS messages to ChannelManager.
      const text: string = message instanceof Buffer ? message.toString('utf8') : (message as string);
      channelManager.publishInbound({
        adapterId: 'http-ws',
        workspaceId: ws.data.workspaceId,
        userId: 'ws-user',
        text,
        raw: message,
      });
    },
  };

  async function start(): Promise<void> {
    const tlsOpts =
      cfg.tlsCert && cfg.tlsKey
        ? { tls: { cert: Bun.file(cfg.tlsCert), key: Bun.file(cfg.tlsKey) } }
        : {};

    // When port === 0 (ephemeral, used in tests), pre-allocate via node:net to
    // work around a Bun/macOS bug where Bun.serve({ port: 0 }).port stays 0.
    const listenPort = port === 0 ? await pickFreePort(bind) : port;

    server = Bun.serve<WsData>({
      hostname: bind,
      port: listenPort,
      ...tlsOpts,
      async fetch(req, bunServer) {
        // WebSocket upgrade for /api/v1/stream.
        const url = new URL(req.url);
        if (url.pathname === '/api/v1/stream') {
          const ip = bunServer.requestIP(req)?.address ?? extractIp(req, cfg.trustedProxy ?? false);
          const result = await validateWsUpgrade(req, resolveWorkspaceForToken, ip);
          if (!result.ok) {
            return jsonResponse({ error: result.message }, result.status);
          }
          const upgraded = bunServer.upgrade(req, {
            data: { workspaceId: result.workspaceId, remoteIp: ip, tokenHint: maskToken(result.token) } satisfies WsData,
          });
          if (!upgraded) return jsonResponse({ error: 'Upgrade failed' }, 500);
          return undefined as unknown as Response;
        }
        return handleRequest(req);
      },
      websocket: wsHandlers,
    });

    // Capture the actual bound port.  Prefer server.port / server.url.port when
    // they are non-zero (works on Linux); fall back to the pre-allocated port.
    const rawPort = server.port ?? 0;
    const urlPort = server.url ? parseInt(server.url.port, 10) : NaN;
    boundPort =
      (rawPort > 0 ? rawPort : null) ??
      (Number.isFinite(urlPort) && urlPort > 0 ? urlPort : null) ??
      listenPort;
    logger.info(
      { bind, port: boundPort, rawServerPort: server.port, serverUrl: server.url?.href },
      'HTTP/WS channel started',
    );
  }

  async function stop(): Promise<void> {
    closeAllWsConnections(1001, 'server stopping');
    if (server) {
      await server.stop(true); // true = close idle connections immediately
    }
    server = null;
    logger.info({ bind, port: boundPort }, 'HTTP/WS channel stopped');
  }

  async function send(_wid: string, text: string): Promise<void> {
    // Broadcast to all open WS connections for this workspace.
    const { broadcastToWorkspace } = await import('./wsStream.ts');
    broadcastToWorkspace(workspaceId, { type: 'message', text, ts: Date.now() });
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
