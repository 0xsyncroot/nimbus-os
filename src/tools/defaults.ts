// defaults.ts — register builtin tools into a registry.

import { createRegistry, type ToolRegistry } from './registry.ts';
import { createReadTool } from './builtin/Read.ts';
import { createWriteTool } from './builtin/Write.ts';
import { createEditTool } from './builtin/Edit.ts';
import { createGrepTool } from './builtin/Grep.ts';
import { createGlobTool } from './builtin/Glob.ts';
import { createBashTool } from './builtin/Bash.ts';
import { createMemoryTool } from './builtin/Memory.ts';

export interface CreateDefaultsOptions {
  includeBash?: boolean;
  includeMemory?: boolean;
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
  return registry;
}
