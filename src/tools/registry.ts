// registry.ts — SPEC-301: in-memory tool registry with JSON schema export.

import { zodToJsonSchema } from './jsonSchema.ts';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import type { Tool, ToolDefinition } from './types.ts';

export interface ToolRegistry {
  register<I, O>(tool: Tool<I, O>): void;
  get(name: string): Tool | undefined;
  list(): Tool[];
  toJsonSchemas(): ToolDefinition[];
  clear(): void;
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();
  return {
    register<I, O>(tool: Tool<I, O>): void {
      if (tools.has(tool.name)) {
        throw new NimbusError(ErrorCode.T_VALIDATION, {
          reason: 'duplicate_tool',
          name: tool.name,
        });
      }
      tools.set(tool.name, tool as Tool);
    },
    get(name: string): Tool | undefined {
      return tools.get(name);
    },
    list(): Tool[] {
      return Array.from(tools.values());
    },
    toJsonSchemas(): ToolDefinition[] {
      return Array.from(tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
      }));
    },
    clear(): void {
      tools.clear();
    },
  };
}
