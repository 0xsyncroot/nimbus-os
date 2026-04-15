// gate.ts — SPEC-401: canUseTool entry point. Routes per-mode through
// rule matcher + path validator + session cache.

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { computeAndAppend } from '../observability/auditLog.ts';
import { logger } from '../observability/logger.ts';
import {
  assertImplemented,
  DESTRUCTIVE_TOOLS,
  READONLY_ALLOWED_TOOLS,
  type PermissionMode,
} from './mode.ts';
import { matchRule, extractMatchTarget } from './matcher.ts';
import type { CompiledRuleSet, Decision } from './rule.ts';
import type { PermissionContext, ToolInvocation } from './types.ts';
import { validatePath } from './pathValidator.ts';
import { isAbsolute, resolve } from 'node:path';

export type { Decision, PermissionContext, ToolInvocation };

export interface Gate {
  canUseTool(inv: ToolInvocation, ctx: PermissionContext): Promise<Decision>;
  rememberAllow(sessionId: string, ruleKey: string): void;
  forgetSession(sessionId: string): void;
}

export interface GateOptions {
  rules: CompiledRuleSet;
  /** Override env reader for tests. */
  env?: NodeJS.ProcessEnv;
  /** Override audit sink for tests. Defaults to computeAndAppend. */
  audit?: (params: {
    sessionId: string;
    toolName: string;
    toolInput: unknown;
    outcome: 'ok' | 'denied' | 'error';
    decisionReason?: string;
  }) => Promise<void>;
  /** Explicit flag indicating the operator passed --dangerously-skip-permissions. */
  bypassCliFlag?: boolean;
}

interface SessionCache {
  allows: Set<string>;
}

function auditAsync(
  fn: (p: Parameters<NonNullable<GateOptions['audit']>>[0]) => Promise<void>,
  params: Parameters<NonNullable<GateOptions['audit']>>[0],
): void {
  fn(params).catch((err) => {
    logger.warn({ err: (err as Error).message }, 'gate audit sink failed');
  });
}

export function createGate(opts: GateOptions): Gate {
  const env = opts.env ?? process.env;
  const bypassCliFlag = opts.bypassCliFlag ?? detectBypassCli();
  const sessions = new Map<string, SessionCache>();
  const audit = opts.audit ?? (async (p) => {
    await computeAndAppend({
      sessionId: p.sessionId,
      kind: 'permission_decision',
      toolName: p.toolName,
      toolInput: p.toolInput,
      outcome: p.outcome,
      ...(p.decisionReason !== undefined ? { decisionReason: p.decisionReason } : {}),
    });
  });

  function cacheFor(sessionId: string): SessionCache {
    let s = sessions.get(sessionId);
    if (!s) {
      s = { allows: new Set() };
      sessions.set(sessionId, s);
    }
    return s;
  }

  async function canUseTool(inv: ToolInvocation, ctx: PermissionContext): Promise<Decision> {
    // 1. Validate mode.
    assertImplemented(ctx.mode);

    // 2. Path-valued invocations always run through the path validator first.
    //    (Denylist wins regardless of rules.)
    const pathCheck = runPathValidator(inv, ctx);
    if (pathCheck) {
      auditAsync(audit, {
        sessionId: ctx.sessionId,
        toolName: inv.name,
        toolInput: inv.input,
        outcome: 'denied',
        decisionReason: pathCheck.reason,
      });
      throw pathCheck.error;
    }

    // 3. Mode-specific decision.
    const decision = decideByMode(inv, ctx, opts.rules, env, bypassCliFlag, cacheFor(ctx.sessionId));

    // 4. Audit critical outcomes.
    if (decision === 'deny') {
      auditAsync(audit, {
        sessionId: ctx.sessionId,
        toolName: inv.name,
        toolInput: inv.input,
        outcome: 'denied',
        decisionReason: `mode=${ctx.mode}`,
      });
    }

    return decision;
  }

  function rememberAllow(sessionId: string, ruleKey: string): void {
    cacheFor(sessionId).allows.add(ruleKey);
  }

  function forgetSession(sessionId: string): void {
    sessions.delete(sessionId);
  }

  return { canUseTool, rememberAllow, forgetSession };
}

function detectBypassCli(): boolean {
  const argv = process.argv;
  return argv.includes('--dangerously-skip-permissions');
}

function decideByMode(
  inv: ToolInvocation,
  ctx: PermissionContext,
  rules: CompiledRuleSet,
  env: NodeJS.ProcessEnv,
  bypassCliFlag: boolean,
  cache: SessionCache,
): Decision {
  const mode = ctx.mode;

  if (mode === 'bypass') {
    if (env['NIMBUS_BYPASS_CONFIRMED'] !== '1' || !bypassCliFlag) {
      throw new NimbusError(ErrorCode.T_PERMISSION, {
        reason: 'bypass_requires_env_and_cli',
        mode,
      });
    }
    logger.warn({ mode: 'bypass', tool: inv.name }, 'bypass mode active');
    return 'allow';
  }

  if (mode === 'readonly') {
    if (READONLY_ALLOWED_TOOLS.has(inv.name)) return 'allow';
    if (DESTRUCTIVE_TOOLS.has(inv.name)) {
      return 'deny';
    }
    // Unknown tool: deny-by-default fail-closed.
    return 'deny';
  }

  // default mode: consult rules.
  const ruleDecision = matchRule(rules, inv);
  if (ruleDecision !== 'no-match') {
    if (ruleDecision === 'ask') {
      const key = askCacheKey(inv);
      if (key && cache.allows.has(key)) return 'allow';
    }
    return ruleDecision;
  }

  // No rule matched. Safe tools auto-allow, destructive tools ask.
  if (READONLY_ALLOWED_TOOLS.has(inv.name)) return 'allow';
  if (DESTRUCTIVE_TOOLS.has(inv.name)) return 'ask';

  // Unknown tool → ask (fail closed relative to allow, but surfaced to user).
  return 'ask';
}

function askCacheKey(inv: ToolInvocation): string | null {
  const target = extractMatchTarget(inv);
  if (target === null) return null;
  return `${inv.name}:${target}`;
}

function runPathValidator(inv: ToolInvocation, ctx: PermissionContext): { error: NimbusError; reason: string } | null {
  const pathTools = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Ls', 'NotebookEdit']);
  if (!pathTools.has(inv.name)) return null;
  const raw = extractPathInput(inv);
  if (raw === null) return null;
  const abs = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
  try {
    validatePath(abs, ctx.cwd);
    return null;
  } catch (err) {
    if (err instanceof NimbusError) {
      return { error: err, reason: String(err.context['label'] ?? err.context['reason'] ?? 'path_blocked') };
    }
    return {
      error: new NimbusError(ErrorCode.X_PATH_BLOCKED, { reason: 'unexpected_validator_error' }, err as Error),
      reason: 'unexpected',
    };
  }
}

function extractPathInput(inv: ToolInvocation): string | null {
  const k = ['path', 'filePath', 'file_path', 'target'];
  for (const key of k) {
    const v = inv.input[key];
    if (typeof v === 'string') return v;
  }
  return null;
}
