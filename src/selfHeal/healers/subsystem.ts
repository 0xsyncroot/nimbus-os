// subsystem.ts — SPEC-602: healer for Y_* error codes.
// Y_OOM: escalate immediately (cannot safely retry under OOM)
// Y_DISK_FULL: auto-prune logs >30d, then retry once
// Y_SUBAGENT_CRASH: retry once then escalate
// Y_DAEMON_CRASH: escalate (daemon restart out of scope in v0.3)
// Y_CIRCUIT_BREAKER_OPEN: escalate with retry-after

import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode } from '../../observability/errors.ts';
import type { NimbusError } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import { logsDir } from '../../platform/paths.ts';
import type { HealDecision } from '../engine.ts';

const LOG_PRUNE_DAYS = 30;

export async function pruneOldLogs(): Promise<number> {
  const dir = join(logsDir(), 'metrics');
  const cutoff = Date.now() - LOG_PRUNE_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  try {
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    for (const f of files) {
      // Never prune audit log
      if (f.includes('audit')) continue;
      const fPath = join(dir, f);
      try {
        const s = await stat(fPath);
        if (s.mtimeMs < cutoff) {
          await unlink(fPath);
          pruned++;
        }
      } catch {
        // skip
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'log prune failed');
  }
  return pruned;
}

export async function healSubsystem(err: NimbusError, attempts: number): Promise<HealDecision> {
  const code = err.code;

  if (code === ErrorCode.Y_OOM) {
    return {
      action: 'escalate',
      notify: 'loud',
      message: 'Out of memory. Reduce context size or restart nimbus.',
    };
  }

  if (code === ErrorCode.Y_DISK_FULL) {
    if (attempts >= 2) {
      return {
        action: 'escalate',
        notify: 'loud',
        message: 'Disk full. Auto-prune could not free sufficient space.',
      };
    }
    // Auto-prune logs >30d (never audit)
    const pruned = await pruneOldLogs();
    logger.info({ pruned }, 'auto-pruned old log files due to Y_DISK_FULL');
    return {
      action: 'retry',
      notify: 'toast',
      message: `Disk full — pruned ${pruned} old log file(s). Retrying.`,
      delayMs: 300,
    };
  }

  if (code === ErrorCode.Y_SUBAGENT_CRASH) {
    if (attempts >= 2) {
      return { action: 'escalate', notify: 'banner', message: 'Sub-agent crashed twice. Giving up.' };
    }
    return { action: 'retry', delayMs: 1000, notify: 'toast', message: 'Sub-agent crashed. Restarting once.' };
  }

  if (code === ErrorCode.Y_DAEMON_CRASH) {
    return {
      action: 'escalate',
      notify: 'loud',
      message: 'Daemon crashed. Run `nimbus daemon start` to restart.',
    };
  }

  if (code === ErrorCode.Y_CIRCUIT_BREAKER_OPEN) {
    const retryAfterMs = typeof err.context['retryAfterMs'] === 'number'
      ? (err.context['retryAfterMs'] as number)
      : 300_000;
    return {
      action: 'escalate',
      notify: 'banner',
      message: `Circuit breaker open. Retry in ${Math.round(retryAfterMs / 1000)}s.`,
    };
  }

  return { action: 'escalate', notify: 'banner', message: `Unhandled subsystem error: ${code}.` };
}
