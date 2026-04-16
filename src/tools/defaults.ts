// defaults.ts — register builtin tools into a registry.

import { createRegistry, type ToolRegistry } from './registry.ts';
import { createReadTool } from './builtin/Read.ts';
import { createWriteTool } from './builtin/Write.ts';
import { createEditTool } from './builtin/Edit.ts';
import { createGrepTool } from './builtin/Grep.ts';
import { createGlobTool } from './builtin/Glob.ts';
import { createBashTool } from './builtin/Bash.ts';
import { createBashOutputTool } from './builtin/BashOutput.ts';
import { createKillBashTool } from './builtin/KillBash.ts';
import { createMemoryTool } from './builtin/Memory.ts';
import { createWebSearchTool } from './builtin/WebSearch.ts';
import { createWebFetchTool } from './builtin/WebFetch.ts';
import { createAgentTool } from './agentTool.ts';
import { createSendMessageTool } from './sendMessage.ts';
import { createReceiveMessageTool } from './receiveMessage.ts';
import { createEnterPlanModeTool } from './enterPlanMode.ts';
import { createExitPlanModeTool } from './exitPlanMode.ts';
import {
  createConnectTelegramTool,
  createDisconnectTelegramTool,
  createTelegramStatusTool,
} from './builtin/Telegram.ts';

export interface CreateDefaultsOptions {
  includeBash?: boolean;
  /** Include BashOutput + KillBash background shell tools. Default: same as includeBash. */
  includeShell?: boolean;
  includeMemory?: boolean;
  includeWeb?: boolean;
  /** Include sub-agent coordination tools (AgentTool, SendMessage, ReceiveMessage). Default: true. */
  includeSubAgent?: boolean;
  /** Include channel-adapter control tools (ConnectTelegram, etc). Default: true. */
  includeChannels?: boolean;
}

export function createDefaultRegistry(opts: CreateDefaultsOptions = {}): ToolRegistry {
  const registry = createRegistry();
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createGrepTool());
  registry.register(createGlobTool());
  if (opts.includeBash !== false) registry.register(createBashTool());
  const includeShell = opts.includeShell ?? opts.includeBash ?? true;
  if (includeShell !== false) {
    registry.register(createBashOutputTool());
    registry.register(createKillBashTool());
  }
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
  // SPEC-133: plan mode tools always registered.
  registry.register(createEnterPlanModeTool());
  registry.register(createExitPlanModeTool());
  // SPEC-808: channel-adapter control tools. Default on so the agent has a real
  // tool to invoke when the user says "kết nối telegram" — without these, v0.3.5
  // agent hallucinated a python bot script.
  if (opts.includeChannels !== false) {
    registry.register(createConnectTelegramTool());
    registry.register(createDisconnectTelegramTool());
    registry.register(createTelegramStatusTool());
  }
  return registry;
}
