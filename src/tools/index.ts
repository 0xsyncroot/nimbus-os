// tools/index.ts — barrel export for SPEC-301/302/303/304.

export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolCall,
  ToolResultBlock,
  ToolDefinition,
} from './types.ts';
export { createRegistry, type ToolRegistry } from './registry.ts';
export { createExecutor, type ToolExecutor, type ExecutorRunContext } from './executor.ts';
export { partitionToolCalls } from './partition.ts';
export { createCancellationScope, type CancellationScope } from './cancellation.ts';
export { createDefaultRegistry } from './defaults.ts';
export { createLoopAdapter } from './loopAdapter.ts';

export { createReadTool, ReadInputSchema } from './builtin/Read.ts';
export { createWriteTool, WriteInputSchema } from './builtin/Write.ts';
export { createEditTool, EditInputSchema } from './builtin/Edit.ts';
export { createGrepTool, GrepInputSchema } from './builtin/Grep.ts';
export { createGlobTool, GlobInputSchema } from './builtin/Glob.ts';
export { createBashTool, BashInputSchema } from './builtin/Bash.ts';
export { createMemoryTool, MemoryInputSchema } from './builtin/Memory.ts';
export {
  createConnectTelegramTool,
  createDisconnectTelegramTool,
  createTelegramStatusTool,
  setTelegramRuntimeBridge,
  ConnectTelegramInputSchema,
  DisconnectTelegramInputSchema,
  TelegramStatusInputSchema,
} from './builtin/Telegram.ts';
