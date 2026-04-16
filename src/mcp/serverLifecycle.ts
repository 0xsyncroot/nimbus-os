// serverLifecycle.ts — SPEC-306: Lazy connect + reconnect backoff + healthcheck.
// Reconnect: exponential backoff 1s-30s, max 5 attempts.

import { logger } from '../observability/logger.ts';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { createMcpClient, type McpClient, type McpClientOptions } from './mcpClient.ts';
import { createTransport } from './transports.ts';
import type { McpServerConfig } from './mcpConfig.ts';
import { withBackoff, DEFAULT_BACKOFF, type BackoffOptions } from './backoff.ts';

export const RECONNECT_BASE_MS = DEFAULT_BACKOFF.baseMs;
export const RECONNECT_MAX_MS = DEFAULT_BACKOFF.maxMs;
export const RECONNECT_MAX_ATTEMPTS = DEFAULT_BACKOFF.maxAttempts;

export interface ServerLifecycleOptions {
  serverName: string;
  config: McpServerConfig;
  clientOptions?: Partial<McpClientOptions>;
  backoff?: BackoffOptions;
  /** Override for testing. */
  _sleep?: (ms: number) => Promise<void>;
}

export interface ManagedMcpServer {
  /** Get the connected client; performs lazy connect on first call. */
  getClient(): Promise<McpClient>;
  /** Explicit disconnect (e.g. agent shutdown). */
  shutdown(): Promise<void>;
  /** Force reconnect (e.g. after detecting stale connection). */
  reconnect(): Promise<McpClient>;
}

/**
 * Create a managed MCP server with lazy connect + reconnect backoff.
 */
export function createManagedServer(opts: ServerLifecycleOptions): ManagedMcpServer {
  const { serverName, config } = opts;
  const backoffOpts = opts.backoff ?? DEFAULT_BACKOFF;

  let client: McpClient | null = null;
  let connectPromise: Promise<McpClient> | null = null;

  async function doConnect(): Promise<McpClient> {
    const c = createMcpClient({
      serverName,
      ...opts.clientOptions,
    });
    const transport = await createTransport(serverName, config);
    await c.connect(transport);
    return c;
  }

  async function connectWithBackoff(): Promise<McpClient> {
    try {
      const c = await withBackoff(
        doConnect,
        backoffOpts,
        opts._sleep,
        (attempt, delayMs, err) => {
          logger.warn(
            {
              serverName,
              attempt: attempt + 1,
              maxAttempts: backoffOpts.maxAttempts,
              delayMs,
              err: err.message,
            },
            'mcp: connect failed, retrying',
          );
        },
      );
      client = c;
      return c;
    } catch (err) {
      throw new NimbusError(
        ErrorCode.T_MCP_UNAVAILABLE,
        {
          serverName,
          reason: 'max_reconnect_attempts_exceeded',
          attempts: backoffOpts.maxAttempts,
        },
        err instanceof Error ? err : undefined,
      );
    }
  }

  async function getClient(): Promise<McpClient> {
    // If already connected and healthy, return it
    if (client?.isConnected()) {
      return client;
    }

    // Deduplicate concurrent connect calls
    if (connectPromise) return connectPromise;

    connectPromise = connectWithBackoff().finally(() => {
      connectPromise = null;
    });
    return connectPromise;
  }

  async function shutdown(): Promise<void> {
    if (client?.isConnected()) {
      await client.disconnect();
    }
    client = null;
    connectPromise = null;
    logger.info({ serverName }, 'mcp: server shut down');
  }

  async function reconnect(): Promise<McpClient> {
    if (client?.isConnected()) {
      await client.disconnect();
    }
    client = null;
    connectPromise = null;
    return getClient();
  }

  return { getClient, shutdown, reconnect };
}

/**
 * Run a simple healthcheck: ping the server.
 * Returns false if ping fails or times out (3s hard limit).
 */
export async function healthcheck(
  server: ManagedMcpServer,
  timeoutMs = 3_000,
): Promise<boolean> {
  try {
    const c = await Promise.race([
      server.getClient(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('healthcheck timeout')), timeoutMs),
      ),
    ]);
    return c.ping();
  } catch {
    return false;
  }
}
