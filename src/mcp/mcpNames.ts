// mcpNames.ts — SPEC-306: MCP tool naming utilities + built-in collision detection.
// Built-in tools ALWAYS win; MCP tools are prefixed mcp__<server>__<tool>.

/** Known built-in tool names. MCP tools with matching bare names get namespaced. */
export const BUILTIN_TOOL_NAMES = new Set<string>([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'Bash',
  'Memory',
  'Ls',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
]);

/**
 * Build the canonical `mcp__<server>__<tool>` name.
 * Server and tool are sanitized: non-alphanumeric chars → underscore.
 */
export function buildMcpToolName(server: string, tool: string): string {
  const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, '_');
  return `mcp__${sanitize(server)}__${sanitize(tool)}`;
}

/**
 * Returns true when a bare tool name collides with a built-in.
 * MCP side must always use the namespaced form; built-in is unaffected.
 */
export function collidesWithBuiltin(toolName: string): boolean {
  return BUILTIN_TOOL_NAMES.has(toolName);
}
