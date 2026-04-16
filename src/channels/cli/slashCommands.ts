// slashCommands.ts — SPEC-801 T3 + SPEC-822 T1: slash command registry + dispatcher.

import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import {
  parseThinkingArg,
  ThinkingParseError,
  type EffortLevel,
} from '../../providers/reasoningResolver.ts';

export interface ReplContext {
  wsId: string;
  write(line: string): void;
  setMode?: (mode: 'readonly' | 'default' | 'acceptEdits' | 'bypass') => void;
  currentMode?: () => 'readonly' | 'default' | 'acceptEdits' | 'bypass';
  cancelTurn?: () => void;
  quit?: () => void;
  newSession?: () => Promise<void>;
  switchWorkspace?: (name: string) => Promise<void>;
  listWorkspaces?: () => Promise<void>;
  showSoul?: () => Promise<void>;
  showMemory?: () => Promise<void>;
  showIdentity?: () => Promise<void>;
  setProvider?: (provider: string) => Promise<void>;
  setModel?: (model: string) => Promise<void>;
  pickModel?: () => Promise<void>;
  showCost?: () => Promise<void>;
  setSpecConfirm?: (mode: 'always' | 'auto') => void;
  /** SPEC-206 T3 — session-scoped reasoning effort override. */
  setThinking?: (effort: EffortLevel) => Promise<void> | void;
  currentThinking?: () => EffortLevel | null;
  [key: string]: unknown;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage: string;
  handler: (args: string, ctx: ReplContext) => Promise<void> | void;
  // SPEC-822 T1 — v0.3 UI polish metadata
  /** Category for grouping in empty-picker view */
  category?: 'session' | 'workspace' | 'model' | 'system';
  /** Arg hint shown in arg-card, e.g. '[name]' */
  argHint?: string;
  /** Enum choices for single-value args, e.g. ['readonly','default','bypass'] */
  argChoices?: string[];
  /** Free-form arg examples, e.g. ['claude-sonnet-4-6', 'gpt-4o'] */
  argExamples?: string[];
}

const registry = new Map<string, SlashCommand>();

export function registerSlash(cmd: SlashCommand): void {
  if (!/^[a-z][a-z0-9-]*$/.test(cmd.name)) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'invalid_slash_name', name: cmd.name });
  }
  registry.set(cmd.name, cmd);
}

export function getCommand(name: string): SlashCommand | undefined {
  return registry.get(name);
}

export function listCommands(): SlashCommand[] {
  return Array.from(registry.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function parseSlash(line: string): { name: string; args: string } | null {
  const m = line.match(/^\/(\w[\w-]*)(?:\s+(.*))?$/);
  if (!m) return null;
  return { name: m[1]!, args: (m[2] ?? '').trim() };
}

export async function dispatchSlash(line: string, ctx: ReplContext): Promise<boolean> {
  const parsed = parseSlash(line);
  if (!parsed) return false;
  const cmd = registry.get(parsed.name);
  if (!cmd) {
    ctx.write(`Unknown command: /${parsed.name}. Try /help`);
    return true;
  }
  try {
    await cmd.handler(parsed.args, ctx);
  } catch (err) {
    if (err instanceof NimbusError) {
      ctx.write(`[ERROR] ${err.code}: ${JSON.stringify(err.context)}`);
    } else {
      ctx.write(`[ERROR] ${(err as Error).message}`);
    }
  }
  return true;
}

export function __resetRegistry(): void {
  registry.clear();
}

export function registerDefaultCommands(): void {
  registerSlash({
    name: 'help',
    description: 'Show available commands',
    usage: '/help',
    category: 'system',
    handler: (_args, ctx) => {
      const lines = listCommands().map((c) => `  /${c.name.padEnd(16)} ${c.description}`);
      ctx.write(['Commands:', ...lines].join('\n'));
    },
  });
  registerSlash({
    name: 'quit',
    description: 'Exit the REPL',
    usage: '/quit',
    category: 'system',
    handler: (_args, ctx) => ctx.quit?.(),
  });
  registerSlash({
    name: 'stop',
    description: 'Cancel the current turn',
    usage: '/stop',
    category: 'session',
    handler: (_args, ctx) => ctx.cancelTurn?.(),
  });
  registerSlash({
    name: 'mode',
    description: 'Get/set permission mode (readonly|default|acceptEdits|bypass)',
    usage: '/mode [readonly|default|acceptEdits|auto|bypass]',
    category: 'system',
    argHint: '[readonly|default|acceptEdits|bypass]',
    argChoices: ['readonly', 'default', 'acceptEdits', 'bypass'],
    handler: (args, ctx) => {
      const raw = args.trim();
      if (raw === '') {
        ctx.write(`mode: ${ctx.currentMode?.() ?? 'default'}`);
        return;
      }
      // SPEC-404: 'auto' is an alias for 'acceptEdits'.
      const v = raw === 'auto' ? 'acceptEdits' : raw;
      if (v !== 'readonly' && v !== 'default' && v !== 'acceptEdits' && v !== 'bypass') {
        ctx.write('usage: /mode <readonly|default|acceptEdits|bypass>');
        return;
      }
      if (v === 'bypass') {
        ctx.write('[WARN] bypass requires --dangerously-skip-permissions + NIMBUS_BYPASS_CONFIRMED=1 at startup');
        return;
      }
      ctx.setMode?.(v);
      if (raw === 'auto') {
        ctx.write('mode set to acceptEdits (auto alias)');
      }
    },
  });
  registerSlash({
    name: 'new',
    description: 'Start a new session in current workspace',
    usage: '/new',
    category: 'session',
    handler: async (_args, ctx) => {
      if (ctx.newSession) await ctx.newSession();
      else ctx.write('new session not supported');
    },
  });
  registerSlash({
    name: 'switch',
    description: 'Switch to another workspace',
    usage: '/switch <name>',
    category: 'workspace',
    argHint: '<name>',
    argExamples: ['personal', 'work', 'research'],
    handler: async (args, ctx) => {
      if (!args) return ctx.write('usage: /switch <name>');
      if (ctx.switchWorkspace) await ctx.switchWorkspace(args);
    },
  });
  registerSlash({
    name: 'workspaces',
    description: 'List workspaces',
    usage: '/workspaces',
    category: 'workspace',
    handler: async (_args, ctx) => {
      if (ctx.listWorkspaces) await ctx.listWorkspaces();
      else ctx.write('not supported');
    },
  });
  registerSlash({
    name: 'soul',
    description: 'Show SOUL.md',
    usage: '/soul',
    category: 'workspace',
    handler: async (_args, ctx) => {
      if (ctx.showSoul) await ctx.showSoul();
    },
  });
  registerSlash({
    name: 'memory',
    description: 'Show MEMORY.md',
    usage: '/memory',
    category: 'workspace',
    handler: async (_args, ctx) => {
      if (ctx.showMemory) await ctx.showMemory();
    },
  });
  registerSlash({
    name: 'provider',
    description: 'Get/set active provider',
    usage: '/provider [name]',
    category: 'model',
    argHint: '[name]',
    argChoices: ['anthropic', 'openai-compat'],
    argExamples: ['anthropic', 'openai-compat'],
    handler: async (args, ctx) => {
      if (ctx.setProvider) await ctx.setProvider(args);
    },
  });
  registerSlash({
    name: 'model',
    description: 'Get/set active model (no arg → interactive picker)',
    usage: '/model [name]',
    category: 'model',
    argHint: '[name]',
    argExamples: ['claude-sonnet-4-6', 'claude-opus-4-5', 'gpt-4o', 'gpt-4o-mini'],
    handler: async (args, ctx) => {
      if (args === '' && ctx.pickModel) {
        await ctx.pickModel();
      } else if (ctx.setModel) {
        await ctx.setModel(args);
      }
    },
  });
  registerSlash({
    name: 'cost',
    description: 'Show cost usage',
    usage: '/cost',
    category: 'session',
    handler: async (_args, ctx) => {
      if (ctx.showCost) await ctx.showCost();
      else ctx.write('cost tracking not available');
    },
  });
  registerSlash({
    name: 'thinking',
    description: 'Set reasoning effort for this session (on|off|minimal|low|medium|high)',
    usage: '/thinking [on|off|minimal|low|medium|high]',
    category: 'model',
    argHint: '[on|off|minimal|low|medium|high]',
    argChoices: ['on', 'off', 'minimal', 'low', 'medium', 'high'],
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (raw === '') {
        const cur = ctx.currentThinking?.() ?? null;
        ctx.write(`thinking: ${cur ?? '(auto — cue-driven)'}`);
        return;
      }
      let effort: EffortLevel;
      try {
        effort = parseThinkingArg(raw);
      } catch (err) {
        if (err instanceof ThinkingParseError) {
          throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
            reason: 'invalid_thinking_arg',
            arg: err.badArg,
            allowed: ['on', 'off', 'minimal', 'low', 'medium', 'high'],
          });
        }
        throw err;
      }
      await ctx.setThinking?.(effort);
      ctx.write(`thinking set to ${effort}`);
    },
  });
  registerSlash({
    name: 'spec-confirm',
    description: 'Set spec-confirm mode (always|auto)',
    usage: '/spec-confirm <always|auto>',
    category: 'system',
    argHint: '<always|auto>',
    argChoices: ['always', 'auto'],
    handler: async (args, ctx) => {
      const v = args.trim();
      if (v !== 'always' && v !== 'auto') {
        return ctx.write('usage: /spec-confirm <always|auto>');
      }
      ctx.setSpecConfirm?.(v);
      ctx.write(`spec-confirm set to ${v}`);
    },
  });
}
