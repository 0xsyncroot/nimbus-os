// transports.ts — SPEC-306: Transport factory for stdio + HTTP streamable MCP transports.
// Bun-native: relies on Bun.spawn for stdio; fetch for HTTP.

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig, McpStdioConfig, McpHttpConfig } from './mcpConfig.ts';
import { sanitizeSubprocessEnv } from './mcpSecurity.ts';
import { ErrorCode, NimbusError } from '../observability/errors.ts';

/** DEFAULT_CONNECT_TIMEOUT_MS — also used in healthcheck */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Build a transport from a validated McpServerConfig.
 * For stdio: sanitizes subprocess env before spawn.
 * For http: passes headers directly (user is responsible for secret hygiene).
 */
export function createTransport(serverName: string, config: McpServerConfig): Transport {
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

function createStdioTransport(serverName: string, config: McpStdioConfig): Transport {
  // Merge base process env + config env, then sanitize
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  const merged = config.env ? { ...baseEnv, ...config.env } : baseEnv;
  const cleanEnv = sanitizeSubprocessEnv(merged);

  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: cleanEnv,
  });
}

function createHttpTransport(serverName: string, config: McpHttpConfig): Transport {
  const url = new URL(config.url);
  const requestInit: RequestInit | undefined = config.headers
    ? { headers: config.headers }
    : undefined;

  return new StreamableHTTPClientTransport(url, requestInit !== undefined ? { requestInit } : undefined);
}
