// loopAdapter.ts — bridges tools registry+executor to core/loop.ts ToolExecutor interface.
// SPEC-825: adds onAsk callback so channel layers can prompt on gate 'ask' decisions.

import type { Gate } from '../permissions/gate.ts';
import { extractMatchTarget } from '../permissions/matcher.ts';
import { ErrorCode } from '../observability/errors.ts';
import type {
  ToolExecutor as LoopToolExecutor,
  ToolInvocation as LoopToolInvocation,
  ToolResult as LoopToolResult,
} from '../core/loop.ts';
import type { ToolDefinition } from '../ir/types.ts';
import type { UIHost } from '../core/ui/index.ts';
import type { ToolRegistry } from './registry.ts';
import { createExecutor } from './executor.ts';

export interface LoopAdapterOptions {
  registry: ToolRegistry;
  permissions: Gate;
  workspaceId: string;
  sessionId: string;
  cwd: string;
  mode: 'default' | 'readonly' | 'acceptEdits' | 'bypass' | 'plan';
  readConcurrency?: number;
  /** SPEC-825: optional channel callback for destructive-tool confirmation.
   *  When the executor returns T_PERMISSION:needs_confirm, the adapter calls this.
   *  - 'allow'  → re-run executor once for this call only
   *  - 'always' → rememberAllow for session then re-run
   *  - 'deny'   → return T_PERMISSION:user_denied synthetic result
   *  When undefined, the original needs_confirm error is returned (non-interactive path). */
  onAsk?: (inv: LoopToolInvocation) => Promise<'allow' | 'deny' | 'always'>;
  /** SPEC-832: optional UIHost for routing confirm prompts through the UIHost contract.
   *  When provided AND host.canAsk()===true, prefer host.ask() over onAsk for
   *  needs_confirm decisions. Falls back to onAsk when host.canAsk()===false or
   *  when host is not provided. */
  host?: UIHost & { canAsk(): boolean };
}

/** SPEC-825: derive the session-scoped allow key for rememberAllow.
 *  Mirrors gate.ts askCacheKey — uses extractMatchTarget for the target. */
function askRuleKey(name: string, input: unknown): string {
  const inv = { name, input: (input ?? {}) as Record<string, unknown> };
  const target = extractMatchTarget(inv);
  return target !== null ? `${name}:${target}` : name;
}

/** SPEC-825: check if a ToolResult block carries T_PERMISSION:needs_confirm. */
function isNeedsConfirm(result: LoopToolResult): boolean {
  if (result.ok) return false;
  const content = typeof result.content === 'string' ? result.content : '';
  return content.includes(ErrorCode.T_PERMISSION) && content.includes('needs_confirm');
}

export function createLoopAdapter(opts: LoopAdapterOptions): LoopToolExecutor {
  const executor = createExecutor({
    registry: opts.registry,
    ...(opts.readConcurrency !== undefined ? { readConcurrency: opts.readConcurrency } : {}),
  });

  function effectOf(name: string): 'pure' | 'read' | 'write' | 'exec' {
    const tool = opts.registry.get(name);
    if (!tool) return 'exec';
    if (tool.readOnly) return 'read';
    if (name === 'Bash') return 'exec';
    return 'write';
  }

  async function runOnce(
    inv: LoopToolInvocation,
    signal: AbortSignal,
  ): Promise<LoopToolResult> {
    const turnId = inv.toolUseId;
    const [block] = await executor.run([
      { toolUseId: inv.toolUseId, name: inv.name, input: inv.input },
    ], {
      workspaceId: opts.workspaceId,
      sessionId: opts.sessionId,
      turnId,
      cwd: opts.cwd,
      mode: opts.mode,
      permissions: opts.permissions,
      parentSignal: signal,
    });
    const effect = effectOf(inv.name);
    if (!block) {
      return {
        toolUseId: inv.toolUseId,
        ok: false,
        content: 'tool execution produced no result',
        sideEffects: effect,
      };
    }
    return {
      toolUseId: inv.toolUseId,
      ok: !(block.block.isError ?? false),
      content: block.block.content,
      sideEffects: effect,
    };
  }

  return {
    listTools(): ToolDefinition[] {
      return opts.registry.toJsonSchemas();
    },
    effectOf,
    async execute(inv: LoopToolInvocation, signal: AbortSignal): Promise<LoopToolResult> {
      const firstResult = await runOnce(inv, signal);

      // SPEC-832: prefer host.ask() when provided and canAsk(); fall back to onAsk.
      const askFn: ((inv: LoopToolInvocation) => Promise<'allow' | 'deny' | 'always'>) | undefined =
        (opts.host && opts.host.canAsk())
          ? async (toolInv: LoopToolInvocation) => {
              const ctx = {
                turnId: toolInv.toolUseId,
                correlationId: toolInv.toolUseId,
                channelId: 'cli' as const,
                abortSignal: signal,
              };
              const result = await opts.host!.ask<'allow' | 'deny' | 'always' | 'never'>(
                { kind: 'confirm', prompt: `Allow tool: ${toolInv.name}?` },
                ctx,
              );
              if (result.kind !== 'ok') return 'deny';
              const v = result.value;
              if (v === 'never') return 'deny';
              return v;
            }
          : opts.onAsk;

      // SPEC-825: if gate returned 'ask' (needs_confirm) and askFn is provided, prompt.
      if (isNeedsConfirm(firstResult) && askFn) {
        const decision = await askFn(inv);
        const effect = effectOf(inv.name);

        if (decision === 'deny') {
          return {
            toolUseId: inv.toolUseId,
            ok: false,
            content: `${ErrorCode.T_PERMISSION}: {"tool":"${inv.name}","reason":"user_denied"}`,
            sideEffects: effect,
          };
        }

        // v0.3.4 (Bug B fix): rememberAllow fires for BOTH 'allow' and
        // 'always' so the second runOnce passes the gate's cache check.
        // The v0.3 session-scoped model makes 'allow' and 'always'
        // equivalent within one session; 'always' persistence across
        // sessions is v0.4 (SPEC-825 §2.2 out-of-scope).
        if (decision === 'always' || decision === 'allow') {
          const key = askRuleKey(inv.name, inv.input);
          opts.permissions.rememberAllow(opts.sessionId, key);
        }

        // 'allow' or 'always' → re-run now that cache/gate will pass
        return await runOnce(inv, signal);
      }

      return firstResult;
    },
  };
}
