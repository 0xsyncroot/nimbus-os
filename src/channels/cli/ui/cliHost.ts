// cliHost.ts — SPEC-832: CliUIHost implements UIHost contract (SPEC-830).
// Wraps existing confirm.ts + onboard/picker.ts behind a UIHost adapter.
// No Ink, no rewrite — adapter pattern. v0.3.15 drain+priming fixes preserved.
//
// Single stdin-owner invariant: ask() acquires a boolean lock; a second
// concurrent call throws U_UI_BUSY rather than silently racing on raw mode.

import type { UIHost, UIIntent, UIContext, UIResult } from '../../../core/ui/index.ts';
import { ErrorCode, NimbusError } from '../../../observability/errors.ts';
import { logger as rootLogger } from '../../../observability/logger.ts';
import { pickOption, confirmOption } from './picker.ts';
import type { Logger } from 'pino';

/** Dependencies injected at CliUIHost creation time. */
export interface CliUIHostDeps {
  /** stdin stream — must be the same stream used by the REPL readline. */
  stdin: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
  /** stdout (or test write stream). */
  stdout: NodeJS.WriteStream;
  /** Whether we are running in an interactive TTY. Drives canAsk(). */
  isTTY: boolean;
  /** Color rendering enabled (respects NO_COLOR). */
  colorEnabled: boolean;
  /** Optional pino logger; falls back to rootLogger. */
  logger?: Logger;
}

/**
 * createCliUIHost — factory producing a UIHost for the CLI channel.
 *
 * id = 'cli'
 * supports = ['confirm', 'pick', 'input', 'status']
 *
 * - confirm → confirmPick arrow-key widget (v0.3.15 drain + priming)
 * - pick    → pickOne arrow-key widget
 * - input   → readline question (echo-off for secret:true)
 * - status  → stdout.write with level prefix; resolves immediately
 *
 * Concurrent ask() calls throw U_UI_BUSY (fail-fast; no silent queuing).
 */
export function createCliUIHost(deps: CliUIHostDeps): UIHost & {
  id: string;
  supports: readonly string[];
  canAsk(): boolean;
} {
  const log = deps.logger ?? rootLogger;
  let busy = false;

  const pickerDeps = {
    stdin: deps.stdin,
    stdout: deps.stdout,
    colorEnabled: deps.colorEnabled,
  };

  /** Level prefix for status messages (NO_COLOR-aware). */
  function statusPrefix(level: 'info' | 'warn' | 'error'): string {
    if (!deps.colorEnabled) {
      return level === 'error' ? '[ERR]' : level === 'warn' ? '[WARN]' : '[INFO]';
    }
    return level === 'error' ? '\x1b[31m[ERR]\x1b[0m' : level === 'warn' ? '\x1b[33m[WARN]\x1b[0m' : '\x1b[36m[INFO]\x1b[0m';
  }

  async function acquireLock(): Promise<void> {
    if (busy) {
      throw new NimbusError(ErrorCode.U_UI_BUSY, {
        reason: 'stdin_in_use',
        hint: 'another prompt is already active; wait for it to resolve',
      });
    }
    busy = true;
  }

  function releaseLock(): void {
    busy = false;
  }

  async function handleConfirm(
    intent: UIIntent & { kind: 'confirm' },
    ctx: UIContext,
  ): Promise<UIResult<'allow' | 'deny' | 'always' | 'never'>> {
    const timeoutMs = intent.timeoutMs;
    const { abortSignal } = ctx;

    if (timeoutMs !== undefined) {
      // Race: picker vs timeout
      const timeoutResult = new Promise<UIResult<'allow' | 'deny' | 'always' | 'never'>>((resolve) => {
        setTimeout(() => {
          deps.stdout.write('\n(timeout — defaulting to deny)\n');
          resolve({ kind: 'timeout' });
        }, timeoutMs);
      });
      return Promise.race([
        confirmOption({ prompt: intent.prompt, signal: abortSignal, deps: pickerDeps }),
        timeoutResult,
      ]);
    }

    return confirmOption({ prompt: intent.prompt, signal: abortSignal, deps: pickerDeps });
  }

  async function handlePick(
    intent: UIIntent & { kind: 'pick' },
    ctx: UIContext,
  ): Promise<UIResult<string>> {
    return pickOption({
      prompt: intent.prompt,
      options: intent.options,
      signal: ctx.abortSignal,
      deps: pickerDeps,
    });
  }

  async function handleInput(
    intent: UIIntent & { kind: 'input' },
    ctx: UIContext,
  ): Promise<UIResult<string>> {
    const { abortSignal } = ctx;
    if (abortSignal.aborted) return { kind: 'cancel' };

    const { createInterface } = await import('node:readline');

    return new Promise<UIResult<string>>((resolve) => {
      const rl = createInterface({ input: deps.stdin, output: deps.stdout, terminal: false });

      const onAbort = (): void => {
        rl.close();
        resolve({ kind: 'cancel' });
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });

      // Echo-off for secret inputs
      if (intent.secret === true) {
        deps.stdout.write(`${intent.prompt}: `);
        // Bun/Node do not have a built-in mute; suppress echo by overriding
        // readline's _writeToOutput. This is the same technique used by
        // `read -s` wrapper libraries.
        const rlAny = rl as unknown as { _writeToOutput?: (s: string) => void };
        rlAny._writeToOutput = (_s: string) => { /* swallow echo */ };
        rl.question('', (answer: string) => {
          abortSignal.removeEventListener('abort', onAbort);
          deps.stdout.write('\n');
          rl.close();
          resolve({ kind: 'ok', value: answer });
        });
      } else {
        rl.question(`${intent.prompt}: `, (answer: string) => {
          abortSignal.removeEventListener('abort', onAbort);
          rl.close();
          resolve({ kind: 'ok', value: answer });
        });
      }
    });
  }

  function handleStatus(
    intent: UIIntent & { kind: 'status' },
  ): UIResult<void> {
    const prefix = statusPrefix(intent.level);
    deps.stdout.write(`${prefix} ${intent.message}\n`);
    return { kind: 'ok', value: undefined };
  }

  return {
    id: 'cli',
    supports: ['confirm', 'pick', 'input', 'status'] as const,

    canAsk(): boolean {
      return deps.isTTY;
    },

    async ask<T>(intent: UIIntent, ctx: UIContext): Promise<UIResult<T>> {
      await acquireLock();
      try {
        switch (intent.kind) {
          case 'confirm':
            return handleConfirm(intent, ctx) as Promise<UIResult<T>>;
          case 'pick':
            return handlePick(intent, ctx) as Promise<UIResult<T>>;
          case 'input':
            return handleInput(intent, ctx) as Promise<UIResult<T>>;
          case 'status': {
            const r = handleStatus(intent);
            return Promise.resolve(r as UIResult<T>);
          }
          default: {
            log.warn({ kind: (intent as UIIntent).kind }, 'cliHost: unhandled intent kind');
            return Promise.resolve({ kind: 'cancel' } as UIResult<T>);
          }
        }
      } finally {
        releaseLock();
      }
    },
  };
}
