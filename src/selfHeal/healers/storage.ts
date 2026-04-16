// storage.ts — SPEC-602: healer for S_* error codes.
// S_STORAGE_CORRUPT: restoreFromBackup action
// S_COMPACT_FAIL: retry with smaller window
// S_SOUL_PARSE: escalate (user file corruption)
// S_CONFIG_INVALID: feed-to-llm (model diagnose)
// S_MEMORY_CONFLICT / S_SCHEMA_MISMATCH: escalate

import { ErrorCode } from '../../observability/errors.ts';
import type { NimbusError } from '../../observability/errors.ts';
import type { HealDecision } from '../engine.ts';

export function healStorage(err: NimbusError, attempts: number): HealDecision {
  const code = err.code;

  if (code === ErrorCode.S_STORAGE_CORRUPT) {
    if (attempts >= 2) {
      return {
        action: 'escalate',
        notify: 'loud',
        message: 'Storage corrupt and backup restore failed. Manual intervention required.',
      };
    }
    return {
      action: 'retry',
      notify: 'banner',
      message: 'Storage corrupt — attempting backup restore.',
      delayMs: 500,
    };
  }

  if (code === ErrorCode.S_COMPACT_FAIL) {
    if (attempts >= 2) {
      return {
        action: 'escalate',
        notify: 'banner',
        message: 'Session compaction failed. Continuing without compaction.',
      };
    }
    // Retry with smaller window — signal via message for loop to act on
    return {
      action: 'retry',
      notify: 'toast',
      message: 'Compaction failed — retrying with smaller window.',
      delayMs: 200,
    };
  }

  if (code === ErrorCode.S_SOUL_PARSE) {
    return {
      action: 'escalate',
      notify: 'loud',
      message: 'SOUL.md parse error. Please check your workspace SOUL.md for syntax issues.',
    };
  }

  if (code === ErrorCode.S_CONFIG_INVALID) {
    return {
      action: 'feed-to-llm',
      notify: 'toast',
      message: 'Config invalid — asking model to diagnose.',
    };
  }

  if (code === ErrorCode.S_MEMORY_CONFLICT || code === ErrorCode.S_SCHEMA_MISMATCH) {
    return {
      action: 'escalate',
      notify: 'banner',
      message: `Storage schema issue: ${code}. Run \`nimbus doctor\` to diagnose.`,
    };
  }

  // Fallback
  if (attempts >= 2) {
    return { action: 'escalate', notify: 'banner', message: `Unrecovered storage error: ${code}.` };
  }
  return { action: 'retry', delayMs: 500, notify: 'toast' };
}
