// toolTranslator.ts — SPEC-306: MCP tool → Canonical IR tool registration.
// Translates MCP tool descriptors to nimbus ToolDefinition with mcp__<server>__<tool> naming.

import { z } from 'zod';
import type { ToolDefinition } from '../ir/types.ts';
import { buildMcpToolName } from './mcpNames.ts';
import { capToolDescription } from './mcpSecurity.ts';

/** MCP tool descriptor as returned by listTools(). */
export interface McpToolDescriptor {
  /** Bare tool name from MCP server (e.g. "search"). */
  name: string;
  /** Human-readable description (may be long; will be capped to 2048 chars). */
  description?: string;
  /** JSON Schema object for the tool input. */
  inputSchema?: unknown;
  /** Server name used for namespacing. */
  serverName: string;
}

/**
 * Translate a single MCP tool descriptor to a CanonicalIR ToolDefinition.
 *
 * - Name is always `mcp__<server>__<tool>` (prevents built-in collision).
 * - Description is capped to 2048 chars.
 * - inputSchema is passed through as-is (untrusted JSON Schema).
 */
export function translateMcpTool(descriptor: McpToolDescriptor): ToolDefinition {
  const namespacedName = buildMcpToolName(descriptor.serverName, descriptor.name);
  const rawDesc = descriptor.description ?? '';
  const description = capToolDescription(rawDesc);
  const inputSchema = resolveInputSchema(descriptor.inputSchema);

  return {
    name: namespacedName,
    description,
    inputSchema,
  };
}

/**
 * Translate a list of MCP tool descriptors for a given server.
 * Deduplicates by namespaced name (first wins, matching Claude Code behavior).
 */
export function translateMcpTools(
  serverName: string,
  mcpTools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): ToolDefinition[] {
  const seen = new Set<string>();
  const result: ToolDefinition[] = [];

  for (const tool of mcpTools) {
    const descriptor: McpToolDescriptor = { ...tool, serverName };
    const translated = translateMcpTool(descriptor);
    if (seen.has(translated.name)) continue;
    seen.add(translated.name);
    result.push(translated);
  }

  return result;
}

/**
 * Build a Zod pass-through schema for an MCP tool input.
 * MCP tool inputs are untrusted JSON — we accept any object and pass through.
 * The agent is responsible for structuring input per the JSON Schema.
 */
export function buildMcpInputSchema(_jsonSchema: unknown): z.ZodTypeAny {
  // Accept any object; MCP SDK will validate against the server's JSON Schema
  return z.record(z.unknown());
}

// ---- Helpers ------------------------------------------------------------------

function resolveInputSchema(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  // Fallback: empty object schema
  return { type: 'object', properties: {} };
}
