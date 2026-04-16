// mcpPermission.ts — SPEC-306 §T6: MCP tools routed through SPEC-401 permission gate.
// MCP tools always use passthrough mode (user confirms each call, no auto-allow).

import type { Gate, Decision } from '../permissions/gate.ts';
import type { PermissionContext } from '../permissions/types.ts';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';

/** MCP tools always require explicit user confirmation — no auto-allow. */
export const MCP_TOOL_DECISION: Decision = 'ask';

export interface McpPermissionCheckParams {
  namespacedToolName: string;
  serverName: string;
  input: Record<string, unknown>;
  gate: Gate;
  ctx: PermissionContext;
}

/**
 * Route an MCP tool call through the SPEC-401 gate.
 * MCP tools always produce 'ask' (passthrough), never auto-allow.
 *
 * Returns 'allow' when the gate grants (user confirmed in session cache or bypass mode).
 * Returns 'ask' when user needs to be prompted.
 * Returns 'deny' if the gate denies (e.g. readonly mode).
 * Throws NimbusError(T_PERMISSION) if gate throws.
 */
export async function checkMcpPermission(params: McpPermissionCheckParams): Promise<Decision> {
  const { namespacedToolName, serverName, input, gate, ctx } = params;

  const invocation = {
    name: namespacedToolName,
    input: input as Record<string, unknown>,
  };

  let decision: Decision;
  try {
    decision = await gate.canUseTool(invocation, ctx);
  } catch (err) {
    if (err instanceof NimbusError) throw err;
    throw new NimbusError(ErrorCode.T_PERMISSION, {
      reason: 'gate_threw',
      toolName: namespacedToolName,
      serverName,
    }, err instanceof Error ? err : undefined);
  }

  logger.debug(
    { toolName: namespacedToolName, serverName, decision },
    'mcp: permission gate decision',
  );

  return decision;
}

/**
 * Assert that a MCP tool is allowed to execute.
 * Throws NimbusError(T_PERMISSION) when decision is 'deny'.
 * When 'ask' is returned, caller must surface prompt to user before proceeding.
 */
export function assertMcpAllowed(decision: Decision, toolName: string): void {
  if (decision === 'deny') {
    throw new NimbusError(ErrorCode.T_PERMISSION, {
      reason: 'mcp_tool_denied',
      toolName,
    });
  }
}
