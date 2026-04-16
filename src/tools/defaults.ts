// defaults.ts — register builtin tools into a registry.

import { createRegistry, type ToolRegistry } from './registry.ts';
import { createReadTool } from './builtin/Read.ts';
import { createWriteTool } from './builtin/Write.ts';
import { createEditTool } from './builtin/Edit.ts';
import { createGrepTool } from './builtin/Grep.ts';
import { createGlobTool } from './builtin/Glob.ts';
import { createBashTool } from './builtin/Bash.ts';
import { createMemoryTool } from './builtin/Memory.ts';
import { createWebSearchTool } from './builtin/WebSearch.ts';
import { createWebFetchTool } from './builtin/WebFetch.ts';
import { createAgentTool } from './agentTool.ts';
import { createSendMessageTool } from './sendMessage.ts';
import { createReceiveMessageTool } from './receiveMessage.ts';

export interface CreateDefaultsOptions {
  includeBash?: boolean;
  includeMemory?: boolean;
  includeWeb?: boolean;
  /** Include sub-agent coordination tools (AgentTool, SendMessage, ReceiveMessage). Default: true. */
  includeSubAgent?: boolean;
}

export function createDefaultRegistry(opts: CreateDefaultsOptions = {}): ToolRegistry {
  const registry = createRegistry();
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createGrepTool());
  registry.register(createGlobTool());
  if (opts.includeBash !== false) registry.register(createBashTool());
  if (opts.includeMemory !== false) registry.register(createMemoryTool());
  if (opts.includeWeb !== false) {
    registry.register(createWebSearchTool());
    registry.register(createWebFetchTool());
  }
  if (opts.includeSubAgent !== false) {
    registry.register(createAgentTool());
    registry.register(createSendMessageTool());
    registry.register(createReceiveMessageTool());
  }
  return registry;
}
