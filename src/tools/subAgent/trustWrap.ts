// trustWrap.ts — SPEC-131 T2: wrap sub-agent text as untrusted CanonicalBlock.
// Lives at src/tools/subAgent/ (layer=tools). All sub-agent output reaching the parent
// model MUST be wrapped via wrapUntrusted() — prompt injection defense.

import type { CanonicalBlock } from '../../ir/types.ts';

/** A text CanonicalBlock with trust + optional origin for sub-agent output. */
export type TrustedBlock = Extract<CanonicalBlock, { type: 'text' }> & {
  trust: 'trusted' | 'untrusted';
  origin?: string;
};

/**
 * Wrap sub-agent text as an untrusted CanonicalBlock (text type).
 * The rendered XML `<untrusted origin="...">` is included in the text so that
 * the system prompt can instruct the model to treat it as data, not instructions.
 */
export function wrapUntrusted(text: string, origin: string): TrustedBlock {
  return {
    type: 'text',
    text: `<untrusted origin="${escapeAttr(origin)}">${text}</untrusted>`,
    trust: 'untrusted',
    origin,
  };
}

/** Wrap text as trusted (first-party content, default). */
export function wrapTrusted(text: string): TrustedBlock {
  return {
    type: 'text',
    text,
    trust: 'trusted',
  };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
