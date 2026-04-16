// wsStream.ts — SPEC-805 T3: WebSocket upgrade + NDJSON token-streaming.
// Per-workspace max 32 concurrent connections → 503 on 33rd.
// Bearer token via Sec-WebSocket-Protocol header or Authorization header.
// NEVER accept tokens in query strings (leaks in logs).

import type { ServerWebSocket } from 'bun';
import { verifyBearer, isIpBanned, recordFailedAuth, maskToken } from './auth.ts';
import { logger } from '../../observability/logger.ts';

const MAX_WS_PER_WORKSPACE = 32;

export interface WsData {
  workspaceId: string;
  remoteIp: string;
  /** Extracted bearer token for the session (used for association only). */
  tokenHint: string;
}

// Track open connections per workspace.
const wsCountByWorkspace = new Map<string, Set<ServerWebSocket<WsData>>>();

function getWorkspaceSet(workspaceId: string): Set<ServerWebSocket<WsData>> {
  let s = wsCountByWorkspace.get(workspaceId);
  if (!s) {
    s = new Set();
    wsCountByWorkspace.set(workspaceId, s);
  }
  return s;
}

/** Called when a WebSocket connection opens. */
export function handleWsOpen(ws: ServerWebSocket<WsData>): void {
  const set = getWorkspaceSet(ws.data.workspaceId);
  set.add(ws);
  logger.debug(
    { workspaceId: ws.data.workspaceId, total: set.size },
    'ws connection opened',
  );
}

/** Called when a WebSocket connection closes. */
export function handleWsClose(ws: ServerWebSocket<WsData>): void {
  const set = wsCountByWorkspace.get(ws.data.workspaceId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) wsCountByWorkspace.delete(ws.data.workspaceId);
  }
  logger.debug({ workspaceId: ws.data.workspaceId }, 'ws connection closed');
}

/** Called when a WebSocket message arrives. */
export function handleWsMessage(
  ws: ServerWebSocket<WsData>,
  message: string | Buffer,
): void {
  // Decode UTF-8 Buffer to string for consistent handling.
  const text = message instanceof Buffer ? message.toString('utf8') : message;
  logger.debug({ workspaceId: ws.data.workspaceId, len: text.length }, 'ws message received');
  // Further message routing is handled by server.ts → ChannelManager.
  void text; // consumed by server.ts handler
}

/** Extract bearer token from upgrade request headers.
 *  Accepts: Sec-WebSocket-Protocol "nimbus.v1, <token>" OR Authorization: Bearer <token>.
 *  Returns null if no token found. */
export function extractWsToken(headers: Headers): string | null {
  // Primary: Sec-WebSocket-Protocol: nimbus.v1, <token>
  const proto = headers.get('Sec-WebSocket-Protocol');
  if (proto) {
    const parts = proto.split(',').map((p) => p.trim());
    // "nimbus.v1" must be first subprotocol; token is the second part.
    if (parts[0] === 'nimbus.v1' && parts[1]) {
      return parts[1];
    }
  }
  // Fallback: Authorization: Bearer <token>
  const auth = headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return null;
}

/** Validate a WebSocket upgrade request.
 *  Returns { ok: true, workspaceId, token } or { ok: false, status, message }. */
export async function validateWsUpgrade(
  req: Request,
  getWorkspaceIdForToken: (token: string) => Promise<string | null>,
  remoteIp: string,
): Promise<
  | { ok: true; workspaceId: string; token: string }
  | { ok: false; status: number; message: string }
> {
  // Reject query-string tokens.
  const url = new URL(req.url);
  if (url.searchParams.has('token')) {
    logger.warn({ remoteIp }, 'ws upgrade rejected: token in query string');
    return { ok: false, status: 401, message: 'Token must not be passed in query string' };
  }

  if (isIpBanned(remoteIp)) {
    return { ok: false, status: 429, message: 'IP banned due to excessive auth failures' };
  }

  const token = extractWsToken(req.headers);
  if (!token) {
    return { ok: false, status: 401, message: 'Missing bearer token' };
  }

  const workspaceId = await getWorkspaceIdForToken(token);
  if (!workspaceId) {
    recordFailedAuth(remoteIp);
    logger.warn({ remoteIp, token: maskToken(token) }, 'ws upgrade: invalid token');
    return { ok: false, status: 401, message: 'Invalid bearer token' };
  }

  const set = getWorkspaceSet(workspaceId);
  if (set.size >= MAX_WS_PER_WORKSPACE) {
    logger.warn({ workspaceId, count: set.size }, 'ws upgrade: max connections exceeded');
    return { ok: false, status: 503, message: 'Max WebSocket connections reached' };
  }

  return { ok: true, workspaceId, token };
}

/** Send an NDJSON frame to a WebSocket client. */
export function sendNdjsonFrame(ws: ServerWebSocket<WsData>, data: unknown): void {
  try {
    ws.send(JSON.stringify(data) + '\n');
  } catch (err) {
    logger.warn({ err }, 'failed to send ws NDJSON frame');
  }
}

/** Broadcast a message to all connected clients for a workspace. */
export function broadcastToWorkspace(workspaceId: string, data: unknown): void {
  const set = wsCountByWorkspace.get(workspaceId);
  if (!set || set.size === 0) return;
  const frame = JSON.stringify(data) + '\n';
  for (const ws of set) {
    try {
      ws.send(frame);
    } catch {
      // best-effort
    }
  }
}

/** Close all WebSocket connections for a workspace. */
export function closeWorkspaceConnections(workspaceId: string, code = 1001, reason = 'server stopping'): void {
  const set = wsCountByWorkspace.get(workspaceId);
  if (!set) return;
  for (const ws of set) {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }
  wsCountByWorkspace.delete(workspaceId);
}

/** Close ALL WebSocket connections across all workspaces. */
export function closeAllWsConnections(code = 1001, reason = 'server stopping'): void {
  for (const workspaceId of Array.from(wsCountByWorkspace.keys())) {
    closeWorkspaceConnections(workspaceId, code, reason);
  }
}

/** Test-only: reset connection map. */
export function __resetWsConnections(): void {
  wsCountByWorkspace.clear();
}

/** Current connection count across all workspaces. */
export function wsConnectionCount(): number {
  let count = 0;
  for (const s of wsCountByWorkspace.values()) count += s.size;
  return count;
}
