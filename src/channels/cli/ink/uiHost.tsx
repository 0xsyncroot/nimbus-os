// uiHost.tsx — SPEC-851: Ink-based UIHost for the REPL Ink path.
// Dispatches 'permission' intents to <PermissionRequest> rendered inline via
// React state. All other intent kinds fall back to NullUIHost (cancel).
// Factory: createInkUIHost(setModalNode) — caller owns the React subtree slot.

import React from 'react';
import type { UIHost, UIIntent, UIContext, UIResult } from '../../../core/ui/index.ts';
import { PermissionRequest } from './components/permissions/PermissionRequest.tsx';
import type { PermissionDialogProps } from './components/permissions/PermissionDialog.tsx';
import { ErrorCode, NimbusError } from '../../../observability/errors.ts';
import { logger } from '../../../observability/logger.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

/** Callback that mounts/unmounts a React node into a slot in the Ink tree. */
export type SetModalNode = (node: React.ReactNode) => void;

/**
 * createInkUIHost — factory for a UIHost that renders Ink components.
 *
 * id = 'cli-ink'
 * supports = ['permission', 'status']
 *
 * - permission → mounts <PermissionRequest> via setModalNode, awaits response
 * - status     → logs via pino (no stdout write in Ink mode — Ink owns stdout)
 * - others     → returns 'cancel' (NullUIHost semantics)
 *
 * Concurrent ask() calls: second call returns 'cancel' immediately (UI busy).
 */
export function createInkUIHost(setModalNode: SetModalNode): UIHost & {
  id: string;
  supports: readonly string[];
  canAsk(): boolean;
} {
  let busy = false;

  return {
    id: 'cli-ink',
    supports: ['permission', 'status'] as const,

    canAsk(): boolean {
      return true;
    },

    async ask<T>(intent: UIIntent, ctx: UIContext): Promise<UIResult<T>> {
      if (intent.kind === 'status') {
        const lvl = intent.level;
        if (lvl === 'error') logger.error({ msg: intent.message }, '[inkUIHost] status');
        else if (lvl === 'warn') logger.warn({ msg: intent.message }, '[inkUIHost] status');
        else logger.info({ msg: intent.message }, '[inkUIHost] status');
        return { kind: 'ok', value: undefined as T };
      }

      if (intent.kind !== 'permission') {
        // All other intents (confirm, pick, input) are not supported in Ink path.
        // Callers must use PromptInput / SlashAutocomplete instead.
        return { kind: 'cancel' };
      }

      if (busy) {
        logger.warn({ toolName: intent.toolName }, '[inkUIHost] ask() busy — returning cancel');
        return { kind: 'cancel' };
      }
      busy = true;

      try {
        return await new Promise<UIResult<T>>((resolve) => {
          const { abortSignal } = ctx;

          function unmount(): void {
            setModalNode(null);
            busy = false;
          }

          const dialogProps: PermissionDialogProps = {
            toolName: intent.toolName,
            toolInput: { detail: intent.detail },
            allowAlways: intent.allowAlways,
            onAllow: () => {
              unmount();
              resolve({ kind: 'ok', value: 'allow' as T });
            },
            onAlways: () => {
              unmount();
              resolve({ kind: 'ok', value: 'always' as T });
            },
            onDeny: () => {
              unmount();
              resolve({ kind: 'ok', value: 'deny' as T });
            },
          };

          // Abort signal: treat as deny + unmount
          const onAbort = (): void => {
            unmount();
            resolve({ kind: 'cancel' });
          };
          abortSignal.addEventListener('abort', onAbort, { once: true });

          // Mount the permission dialog into the Ink tree
          setModalNode(
            React.createElement(PermissionRequest, {
              ...dialogProps,
              onAllow: () => {
                abortSignal.removeEventListener('abort', onAbort);
                dialogProps.onAllow();
              },
              onAlways: () => {
                abortSignal.removeEventListener('abort', onAbort);
                dialogProps.onAlways();
              },
              onDeny: () => {
                abortSignal.removeEventListener('abort', onAbort);
                dialogProps.onDeny();
              },
            }),
          );
        });
      } catch (err) {
        busy = false;
        setModalNode(null);
        logger.error({ err }, '[inkUIHost] permission dialog threw');
        throw new NimbusError(ErrorCode.U_UI_BUSY, {
          reason: 'permission_dialog_error',
          hint: (err as Error).message,
        });
      }
    },
  };
}
