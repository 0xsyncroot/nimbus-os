// engine.ts — SPEC-602: SelfHealEngine — classify errors, apply policy, return HealDecision.
// Security gate: X_* codes escalate immediately with SecurityEvent, no state write, no retry.
// Circuit breaker: 3 consecutive failures within 60s → open 5min.

import { ErrorCode } from '../observability/errors.ts';
import type { NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { getGlobalHealCircuit } from './circuit.ts';
import { healProvider } from './healers/provider.ts';
import { healTool } from './healers/tool.ts';
import { healStorage } from './healers/storage.ts';
import { healSubsystem } from './healers/subsystem.ts';

export interface HealDecision {
  action: 'retry' | 'feed-to-llm' | 'escalate' | 'compact-then-retry' | 'switch-model';
  delayMs?: number;
  notify: 'silent' | 'toast' | 'banner' | 'loud';
  message?: string;
  newModel?: string;
}

interface HealState {
  errorCode: ErrorCode;
  attempts: number;
  lastAttemptAt: number;
}

export interface SelfHealEngine {
  handle(err: NimbusError, ctx: { turnId: string }): Promise<HealDecision>;
  resetTurn(turnId: string): void;
}

function isSecurityCode(code: ErrorCode): boolean {
  return (
    code === ErrorCode.X_BASH_BLOCKED ||
    code === ErrorCode.X_PATH_BLOCKED ||
    code === ErrorCode.X_NETWORK_BLOCKED ||
    code === ErrorCode.X_INJECTION ||
    code === ErrorCode.X_CRED_ACCESS ||
    code === ErrorCode.X_AUDIT_BREAK
  );
}

function isProviderCode(code: ErrorCode): boolean {
  return code.startsWith('P_');
}

function isToolCode(code: ErrorCode): boolean {
  return code.startsWith('T_') || code.startsWith('U_');
}

function isStorageCode(code: ErrorCode): boolean {
  return code.startsWith('S_');
}

function isSubsystemCode(code: ErrorCode): boolean {
  return code.startsWith('Y_');
}

export function createSelfHealEngine(): SelfHealEngine {
  // State keyed by "turnId:errorCode" — NEVER cross-turn pollution
  const turnState = new Map<string, HealState>();
  const circuit = getGlobalHealCircuit();

  function stateKey(turnId: string, code: ErrorCode): string {
    return `${turnId}:${code}`;
  }

  function getState(turnId: string, code: ErrorCode): HealState {
    const key = stateKey(turnId, code);
    let s = turnState.get(key);
    if (!s) {
      s = { errorCode: code, attempts: 0, lastAttemptAt: 0 };
      turnState.set(key, s);
    }
    return s;
  }

  async function handle(err: NimbusError, ctx: { turnId: string }): Promise<HealDecision> {
    const code = err.code;

    // Security gate: NEVER auto-recover X_* codes
    if (isSecurityCode(code)) {
      // Log SecurityEvent — no state write
      logger.warn(
        { code, context: err.context, turnId: ctx.turnId, event: 'security_event' },
        'SecurityEvent: X_* error escalated immediately',
      );
      return {
        action: 'escalate',
        notify: 'loud',
        message: `Security violation: ${code}. No auto-recovery. Review audit log.`,
      };
    }

    // Circuit breaker check — global per errorCode
    if (circuit.isOpen(code)) {
      const openUntil = circuit.openUntilMs(code);
      const retryAfterMs = Math.max(0, openUntil - Date.now());
      return {
        action: 'escalate',
        notify: 'banner',
        message: `Circuit breaker open for ${code}. Retry in ${Math.round(retryAfterMs / 1000)}s.`,
      };
    }

    // Get per-turn state and increment attempts
    const state = getState(ctx.turnId, code);
    state.attempts += 1;
    state.lastAttemptAt = Date.now();

    let decision: HealDecision;

    if (isProviderCode(code)) {
      decision = healProvider(err, state.attempts);
    } else if (isStorageCode(code)) {
      decision = healStorage(err, state.attempts);
    } else if (isSubsystemCode(code)) {
      decision = await healSubsystem(err, state.attempts);
    } else {
      // T_*, U_* and fallback
      decision = healTool(err, state.attempts);
    }

    // Record to circuit breaker on escalation
    if (decision.action === 'escalate') {
      circuit.recordFailure(code);
    }

    return decision;
  }

  function resetTurn(turnId: string): void {
    for (const key of turnState.keys()) {
      if (key.startsWith(`${turnId}:`)) {
        turnState.delete(key);
      }
    }
  }

  return { handle, resetTurn };
}

// Module-level singleton
let _engine: SelfHealEngine | null = null;

export function getSelfHealEngine(): SelfHealEngine {
  if (!_engine) _engine = createSelfHealEngine();
  return _engine;
}

export function __resetSelfHealEngine(): void {
  _engine = null;
}
