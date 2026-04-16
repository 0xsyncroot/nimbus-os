// prompts.ts — SPEC-105: deterministic system prompt assembly with cache breakpoints.
// SPEC-122: [SESSION_PREFS] block injection.
// SPEC-132: [INTERNAL_PLAN] / taskSpec removed — TodoWriteTool replaces out-of-band spec.

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import type { CanonicalBlock, ProviderCapabilities } from '../ir/types.ts';
import type { WorkspaceMemory } from './memoryTypes.ts';
import type { SessionPreferences } from './sessionPreferences.ts';
import {
  AUTONOMY_SECTION,
  CHANNELS_SECTION,
  CREDENTIAL_HANDLING_SECTION,
  PROMPT_SIZE_ERROR_BYTES,
  PROMPT_SIZE_WARN_BYTES,
  SAFETY_SECTION,
  TOOL_USAGE_SECTION,
  UNTRUSTED_CONTENT_SECTION,
} from './promptSections.ts';

export interface BuildPromptInput {
  memory: WorkspaceMemory;
  caps: ProviderCapabilities;
  planCue?: string;
  environmentXml?: string;
  sessionPrefs?: SessionPreferences;
}

/**
 * Build the [SESSION_PREFS] block string.
 * Returns empty string when prefs object has no keys set (block omitted from prompt).
 */
export function buildSessionPrefsBlock(prefs: SessionPreferences): string {
  const lines: string[] = [];
  if (prefs.agentName) lines.push(`agentName: ${prefs.agentName}`);
  if (prefs.pronoun) lines.push(`pronoun: ${prefs.pronoun}`);
  if (prefs.language) lines.push(`language: ${prefs.language}`);
  if (prefs.voice) lines.push(`voice: ${prefs.voice}`);
  if (lines.length === 0) return '';
  return `[SESSION_PREFS]\n${lines.join('\n')}\n`;
}

function textBlock(text: string, cache?: 'ephemeral'): CanonicalBlock {
  if (cache) return { type: 'text', text, cacheHint: cache };
  return { type: 'text', text };
}

export function buildSystemPrompt(input: BuildPromptInput): CanonicalBlock[] {
  const { memory, caps, planCue, environmentXml, sessionPrefs } = input;
  const explicit = caps.promptCaching === 'explicit';

  const blocks: CanonicalBlock[] = [];

  // 1. SOUL
  blocks.push(textBlock(`[SOUL]\n${memory.soulMd.body.trim()}\n`));
  // 2. IDENTITY (optional)
  if (memory.identityMd) {
    blocks.push(textBlock(`[IDENTITY]\n${memory.identityMd.body.trim()}\n`, explicit ? 'ephemeral' : undefined));
  } else {
    // attach breakpoint to SOUL when IDENTITY absent
    if (explicit) {
      const last = blocks[blocks.length - 1]!;
      if (last.type === 'text') last.cacheHint = 'ephemeral';
    }
  }

  // 2b. SESSION_PREFS — injected after IDENTITY, before autonomy (SPEC-122)
  if (sessionPrefs) {
    const prefsBlock = buildSessionPrefsBlock(sessionPrefs);
    if (prefsBlock.length > 0) {
      blocks.push(textBlock(prefsBlock));
    }
  }

  // 3-7. Static sections
  blocks.push(textBlock(AUTONOMY_SECTION));
  if (planCue && planCue.length > 0) {
    blocks.push(textBlock(`${planCue}\n`));
  }
  blocks.push(textBlock(CREDENTIAL_HANDLING_SECTION));
  blocks.push(textBlock(SAFETY_SECTION));
  blocks.push(textBlock(UNTRUSTED_CONTENT_SECTION));
  blocks.push(textBlock(TOOL_USAGE_SECTION));

  // SPEC-808: CHANNELS — tell the agent the built-in adapters exist so it
  // doesn't hallucinate a python bot script when the user asks to connect a
  // channel (v0.3.5 regression).
  blocks.push(textBlock(CHANNELS_SECTION));

  // 7. MEMORY
  blocks.push(textBlock(`[MEMORY]\n${memory.memoryMd.body.trim()}\n`));

  // NOTE: [INTERNAL_PLAN] / taskSpec removed by SPEC-132.
  // Plan-as-tool (TodoWriteTool) replaces out-of-band spec injection.

  // 8. TOOLS_AVAILABLE — final cacheable breakpoint
  blocks.push(
    textBlock(`[TOOLS_AVAILABLE]\n${memory.toolsMd.body.trim()}\n`, explicit ? 'ephemeral' : undefined),
  );

  // 9. ENVIRONMENT (dynamic, below breakpoint 2 — NOT cached)
  if (environmentXml && environmentXml.length > 0) {
    blocks.push(textBlock(`[ENVIRONMENT]\n${environmentXml}\n`));
  }

  // Strip cacheHint if provider doesn't support explicit caching.
  if (!explicit) {
    for (const b of blocks) {
      if (b.type === 'text' && b.cacheHint !== undefined) delete b.cacheHint;
    }
  }

  // Size guard
  let totalBytes = 0;
  for (const b of blocks) {
    if (b.type === 'text') totalBytes += Buffer.byteLength(b.text, 'utf8');
  }
  if (totalBytes > PROMPT_SIZE_ERROR_BYTES) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'prompt_too_large',
      size: totalBytes,
      max: PROMPT_SIZE_ERROR_BYTES,
    });
  }
  if (totalBytes > PROMPT_SIZE_WARN_BYTES) {
    logger.warn({ size: totalBytes, warn: PROMPT_SIZE_WARN_BYTES }, 'system prompt size exceeds warn threshold');
  }

  return blocks;
}
