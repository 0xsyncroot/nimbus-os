// transports.ts — SPEC-306: Transport factory for stdio + HTTP streamable MCP transports.
// Bun-native: relies on Bun.spawn for stdio; fetch for HTTP.
// SDK is loaded via dynamic import to allow typecheck without SDK installed.

import type { McpServerConfig, McpStdioConfig, McpHttpConfig } from './mcpConfig.ts';
import { sanitizeSubprocessEnv } from './mcpSecurity.ts';
import { ErrorCode, NimbusError } from '../observability/errors.ts';

/** DEFAULT_CONNECT_TIMEOUT_MS — also used in healthcheck */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

// Use structural typing for Transport to avoid hard SDK dep at the type level.
// The SDK's Transport interface matches this shape.
export interface Transport {
  start(): Promise<void>;
  close(): Promise<void>;
  send(message: unknown): Promise<void>;
  onmessage?: ((message: unknown) => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onclose?: (() => void) | undefined;
}

/**
 * Build a transport from a validated McpServerConfig.
 * For stdio: sanitizes subprocess env before spawn.
 * For http: passes headers directly (user is responsible for secret hygiene).
 */
export async function createTransport(serverName: string, config: McpServerConfig): Promise<Transport> {
  if (config.type === 'stdio') {
    return createStdioTransport(serverName, config);
  }
  if (config.type === 'http') {
    return createHttpTransport(serverName, config);
  }
  // Exhaustive check
  const _never: never = config;
  throw new NimbusError(ErrorCode.T_VALIDATION, {
    reason: 'unknown_transport_type',
    serverName,
    config: _never,
  });
}

async function createStdioTransport(serverName: string, config: McpStdioConfig): Promise<Transport> {
  // Merge base process env + config env, then sanitize
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  const merged = config.env ? { ...baseEnv, ...config.env } : baseEnv;
  const cleanEnv = sanitizeSubprocessEnv(merged);

  // Dynamic import to avoid hard compile-time dep
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: cleanEnv,
  }) as unknown as Transport;
}

async function createHttpTransport(_serverName: string, config: McpHttpConfig): Promise<Transport> {
  const url = new URL(config.url);
  const requestInit: RequestInit | undefined = config.headers
    ? { headers: config.headers }
    : undefined;

  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  return new StreamableHTTPClientTransport(
    url,
    requestInit !== undefined ? { requestInit } : undefined,
  ) as unknown as Transport;
}
