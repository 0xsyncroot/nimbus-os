// mcpConfig.ts — SPEC-306: McpServerConfig Zod schema (stdio + http) + env var expansion.
// Config is loaded from .mcp.json (project-scope) or workspace.json mcpServers (user-scope).

import { z } from 'zod';
import { join } from 'node:path';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';

// ---- Schemas ------------------------------------------------------------------

export const McpStdioConfig = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /** Env vars for subprocess. ${VAR} expansion performed on values. */
  env: z.record(z.string()).optional(),
  /** Tool call timeout in ms. Default 60_000. */
  timeout: z.number().int().positive().optional(),
});

export const McpHttpConfig = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  /** Extra HTTP headers (e.g. Authorization). Values support ${VAR} expansion. */
  headers: z.record(z.string()).optional(),
  /** Tool call timeout in ms. Default 60_000. */
  timeout: z.number().int().positive().optional(),
});

export const McpServerConfig = z.discriminatedUnion('type', [McpStdioConfig, McpHttpConfig]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;
export type McpStdioConfig = z.infer<typeof McpStdioConfig>;
export type McpHttpConfig = z.infer<typeof McpHttpConfig>;

/** Named map of server configs (key = server name used for namespacing). */
export const McpServersMap = z.record(z.string().min(1), McpServerConfig);
export type McpServersMap = z.infer<typeof McpServersMap>;

/** Top-level shape of .mcp.json */
const McpJsonFile = z.object({
  mcpServers: McpServersMap,
});

// ---- Env var expansion --------------------------------------------------------

/** Pattern: ${VAR_NAME} — expands from process.env. */
const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function expandEnvVars(
  value: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return value.replace(ENV_VAR_PATTERN, (_match, name: string) => {
    return env[name] ?? '';
  });
}

/** Expand all string values inside an env record. Returns a new object. */
export function expandEnvRecord(
  rec: Record<string, string>,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = expandEnvVars(v, env);
  }
  return out;
}

// ---- Config loaders -----------------------------------------------------------

/**
 * Load + parse + validate .mcp.json from cwd.
 * Returns empty map when file not found. Throws NimbusError(S_CONFIG_INVALID) on parse error.
 */
export async function loadMcpJsonFile(cwd: string): Promise<McpServersMap> {
  const filePath = join(cwd, '.mcp.json');
  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch {
    // File not present — normal case
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NimbusError(
      ErrorCode.S_CONFIG_INVALID,
      { source: '.mcp.json', reason: 'json_parse_error' },
      err instanceof Error ? err : undefined,
    );
  }

  const result = McpJsonFile.safeParse(parsed);
  if (!result.success) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      source: '.mcp.json',
      reason: 'schema_validation_failed',
      issues: result.error.issues,
    });
  }

  logger.debug({ count: Object.keys(result.data.mcpServers).length }, 'mcp: loaded .mcp.json');
  return result.data.mcpServers;
}

/**
 * Merge project-scope (.mcp.json) + user-scope (workspace.json mcpServers).
 * Project-scope wins on name collision (inner loop override).
 */
export function mergeMcpConfigs(
  userServers: McpServersMap,
  projectServers: McpServersMap,
): McpServersMap {
  return { ...userServers, ...projectServers };
}

/**
 * Apply env-var expansion to a parsed config entry's mutable string fields.
 */
export function expandConfigEnv(
  config: McpServerConfig,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): McpServerConfig {
  if (config.type === 'stdio') {
    return {
      ...config,
      command: expandEnvVars(config.command, env),
      args: config.args?.map((a) => expandEnvVars(a, env)),
      env: config.env ? expandEnvRecord(config.env, env) : config.env,
    };
  }
  // http
  return {
    ...config,
    url: expandEnvVars(config.url, env),
    headers: config.headers ? expandEnvRecord(config.headers, env) : config.headers,
  };
}
