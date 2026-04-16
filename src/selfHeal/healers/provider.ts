// provider.ts — SPEC-602: healer for P_* error codes.
// P_NETWORK/P_5XX: exponential backoff retry (max 3)
// P_429: honor Retry-After if in context, else exp backoff
// P_AUTH: 0 retries — loud escalate (account lockout risk)
// P_CONTEXT_OVERFLOW: compact-then-retry
// P_MODEL_NOT_FOUND / P_INVALID_REQUEST: switch-model after 2 failures

import { ErrorCode } from '../../observability/errors.ts';
import type { NimbusError } from '../../observability/errors.ts';
import type { HealDecision } from '../engine.ts';

const BASE_DELAY_MS = 300;
const MAX_DELAY_MS = 30_000;
const JITTER_FACTOR = 0.3;

function expBackoff(attempts: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempts - 1), MAX_DELAY_MS);
  const jitter = base * JITTER_FACTOR * Math.random();
  return Math.round(base + jitter);
}

export function healProvider(err: NimbusError, attempts: number): HealDecision {
  const code = err.code;

  if (code === ErrorCode.P_AUTH) {
    return {
      action: 'escalate',
      notify: 'loud',
      message: 'Provider authentication failed. Check your API key (nimbus key set).',
    };
  }

  if (code === ErrorCode.P_CONTEXT_OVERFLOW) {
    return {
      action: 'compact-then-retry',
      notify: 'toast',
      message: 'Context window full — compacting conversation.',
    };
  }

  if (code === ErrorCode.P_429) {
    // Honor retry-after from error context if available
    const retryAfter = typeof err.context['retryAfterMs'] === 'number'
      ? (err.context['retryAfterMs'] as number)
      : expBackoff(attempts);
    if (attempts >= 3) {
      return { action: 'escalate', notify: 'banner', message: 'Rate limit persistent — pausing.' };
    }
    return { action: 'retry', delayMs: retryAfter, notify: 'toast', message: `Rate limited. Retrying in ${Math.round(retryAfter / 1000)}s.` };
  }

  if (code === ErrorCode.P_MODEL_NOT_FOUND || code === ErrorCode.P_INVALID_REQUEST) {
    if (attempts >= 2) {
      return { action: 'switch-model', notify: 'toast', message: 'Switching to fallback model.' };
    }
    return { action: 'retry', delayMs: expBackoff(attempts), notify: 'silent' };
  }

  // P_NETWORK, P_5XX — retry with exp backoff, escalate after 3 attempts
  if (attempts >= 3) {
    return { action: 'escalate', notify: 'banner', message: `Provider error ${code} persists after 3 retries.` };
  }
  return {
    action: 'retry',
    delayMs: expBackoff(attempts),
    notify: attempts >= 2 ? 'toast' : 'silent',
  };
}
