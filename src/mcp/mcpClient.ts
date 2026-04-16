// mcpClient.ts — SPEC-306: MCPClient using @modelcontextprotocol/sdk.
// Provides connect, disconnect, callTool, listTools, listResources.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, NimbusError, wrapError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { capToolOutput } from './mcpSecurity.ts';

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export interface McpClientOptions {
  serverName: string;
  toolTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface McpToolCallResult {
  content: string;
  isError: boolean;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpClient {
  readonly serverName: string;
  connect(transport: Transport): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  listTools(): Promise<McpTool[]>;
  listResources(): Promise<McpResource[]>;
  callTool(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult>;
  isConnected(): boolean;
}

/**
 * Create an MCPClient for a named server.
 * The client is stateful: track connection via internal flag.
 */
export function createMcpClient(opts: McpClientOptions): McpClient {
  const { serverName } = opts;
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  let sdkClient: Client | null = null;
  let connected = false;

  async function connect(transport: Transport): Promise<void> {
    if (connected) return;

    sdkClient = new Client(
      { name: `nimbus-mcp-${serverName}`, version: '0.1.0' },
      { capabilities: {} },
    );

    try {
      const connectPromise = sdkClient.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`connect timeout after ${connectTimeoutMs}ms`)), connectTimeoutMs),
      );
      await Promise.race([connectPromise, timeoutPromise]);
      connected = true;
      logger.info({ serverName }, 'mcp: connected');
    } catch (err) {
      sdkClient = null;
      throw wrapError(err, ErrorCode.T_MCP_UNAVAILABLE, { serverName, phase: 'connect' });
    }
  }

  async function disconnect(): Promise<void> {
    if (!connected || !sdkClient) return;
    try {
      await sdkClient.close();
    } catch (err) {
      logger.warn({ serverName, err: (err as Error).message }, 'mcp: disconnect error (ignoring)');
    } finally {
      sdkClient = null;
      connected = false;
      logger.info({ serverName }, 'mcp: disconnected');
    }
  }

  async function ping(): Promise<boolean> {
    if (!connected || !sdkClient) return false;
    try {
      await sdkClient.ping();
      return true;
    } catch {
      return false;
    }
  }

  async function listTools(): Promise<McpTool[]> {
    assertConnected();
    try {
      const result = await sdkClient!.listTools();
      return result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    } catch (err) {
      throw wrapError(err, ErrorCode.T_MCP_UNAVAILABLE, { serverName, op: 'listTools' });
    }
  }

  async function listResources(): Promise<McpResource[]> {
    assertConnected();
    try {
      const result = await sdkClient!.listResources();
      return result.resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    } catch (err) {
      throw wrapError(err, ErrorCode.T_MCP_UNAVAILABLE, { serverName, op: 'listResources' });
    }
  }

  async function callTool(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    assertConnected();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), toolTimeoutMs);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    try {
      const result = await Promise.race([
        sdkClient!.callTool({ name: toolName, arguments: input }),
        new Promise<never>((_, reject) => {
          combined.addEventListener('abort', () =>
            reject(new Error(`tool call timeout after ${toolTimeoutMs}ms`)),
          );
        }),
      ]);

      clearTimeout(timeoutId);

      const rawContent = extractTextContent(result.content);
      const cappedContent = capToolOutput(rawContent);
      const isError = result.isError === true;

      return { content: cappedContent, isError };
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).message?.includes('timeout')) {
        throw new NimbusError(ErrorCode.T_TIMEOUT, { serverName, toolName, timeoutMs: toolTimeoutMs });
      }
      throw wrapError(err, ErrorCode.T_MCP_UNAVAILABLE, { serverName, toolName, op: 'callTool' });
    }
  }

  function isConnected(): boolean {
    return connected;
  }

  function assertConnected(): void {
    if (!connected || !sdkClient) {
      throw new NimbusError(ErrorCode.T_MCP_UNAVAILABLE, {
        serverName,
        reason: 'not_connected',
      });
    }
  }

  return { serverName, connect, disconnect, ping, listTools, listResources, callTool, isConnected };
}

// ---- Helpers ------------------------------------------------------------------

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? '');
  const parts: string[] = [];
  for (const item of content) {
    if (item !== null && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      if (obj['type'] === 'text' && typeof obj['text'] === 'string') {
        parts.push(obj['text']);
      } else if (typeof obj['text'] === 'string') {
        parts.push(obj['text']);
      } else {
        parts.push(JSON.stringify(obj));
      }
    } else {
      parts.push(String(item));
    }
  }
  return parts.join('\n');
}
