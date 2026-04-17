// uiHost.ts — SPEC-830: UIHost interface + NullUIHost sentinel.
// Pure TS: no Bun APIs, no node:* imports — reusable from future mobile client.

import type { UIContext, UIIntent, UIResult } from './intent.ts';

// ---------------------------------------------------------------------------
// UIHost — channel-agnostic contract for interactive user prompts.
// Implementations live in SPEC-831 (Telegram) and SPEC-832 (CLI).
// ---------------------------------------------------------------------------

export interface UIHost {
  /** ask — send an intent to the user and await their response.
   *  @param intent - the structured prompt to display.
   *  @param ctx    - per-turn context including channelId + abortSignal.
   *  @returns UIResult<T> — 'ok' with value, 'cancel', or 'timeout'.
   *  Channels may return 'timeout' after ctx.abortSignal fires. */
  ask<T>(intent: UIIntent, ctx: UIContext): Promise<UIResult<T>>;
}

// ---------------------------------------------------------------------------
// NullUIHost — sentinel for non-interactive channels (e.g., headless daemon).
// Returns 'cancel' for every intent; never throws.
// ---------------------------------------------------------------------------

export class NullUIHost implements UIHost {
  ask<T>(_intent: UIIntent, _ctx: UIContext): Promise<UIResult<T>> {
    return Promise.resolve({ kind: 'cancel' } as UIResult<T>);
  }
}
