// tool.ts — SPEC-602: healer for T_* and U_* error codes.
// T_TIMEOUT: retry 1x then escalate
// T_CRASH: retry 1x, feed-to-llm on 2nd fail
// T_VALIDATION: feed-to-llm (let model fix input)
// T_PERMISSION: escalate immediately (user must grant)
// T_NOT_FOUND: feed-to-llm
// T_MCP_UNAVAILABLE: retry 2x then escalate
// T_ITERATION_CAP: escalate
// U_*: feed-to-llm or escalate

import { ErrorCode } from '../../observability/errors.ts';
import type { NimbusError } from '../../observability/errors.ts';
import type { HealDecision } from '../engine.ts';

export function healTool(err: NimbusError, attempts: number): HealDecision {
  const code = err.code;

  if (code === ErrorCode.T_PERMISSION) {
    return {
      action: 'escalate',
      notify: 'loud',
      message: 'Tool permission denied. Adjust permissions or use a different tool.',
    };
  }

  if (code === ErrorCode.T_ITERATION_CAP) {
    return {
      action: 'escalate',
      notify: 'banner',
      message: 'Tool iteration cap reached. Breaking agent loop.',
    };
  }

  if (code === ErrorCode.T_VALIDATION || code === ErrorCode.T_NOT_FOUND) {
    return {
      action: 'feed-to-llm',
      notify: 'silent',
      message: `Tool error: ${code}. Asking model for alternative approach.`,
    };
  }

  if (code === ErrorCode.T_CRASH) {
    if (attempts >= 2) {
      return {
        action: 'feed-to-llm',
        notify: 'toast',
        message: 'Tool crashed twice. Feeding error to model for recovery.',
      };
    }
    return { action: 'retry', delayMs: 500, notify: 'silent' };
  }

  if (code === ErrorCode.T_TIMEOUT) {
    if (attempts >= 2) {
      return { action: 'escalate', notify: 'banner', message: 'Tool timed out. Giving up.' };
    }
    return { action: 'retry', delayMs: 1000, notify: 'toast', message: 'Tool timed out. Retrying once.' };
  }

  if (code === ErrorCode.T_MCP_UNAVAILABLE) {
    if (attempts >= 2) {
      return { action: 'escalate', notify: 'banner', message: 'MCP server unavailable after retries.' };
    }
    return { action: 'retry', delayMs: 2000, notify: 'toast', message: 'MCP server unavailable. Retrying.' };
  }

  // U_BAD_COMMAND, U_MISSING_CONFIG — feed-to-llm
  if (code === ErrorCode.U_BAD_COMMAND || code === ErrorCode.U_MISSING_CONFIG) {
    return {
      action: 'feed-to-llm',
      notify: 'toast',
      message: `User command error: ${code}. Letting model suggest a fix.`,
    };
  }

  // Fallback for remaining T_* / U_*
  if (attempts >= 2) {
    return { action: 'escalate', notify: 'banner', message: `Unhandled tool error: ${code}.` };
  }
  return { action: 'retry', delayMs: 300, notify: 'silent' };
}
