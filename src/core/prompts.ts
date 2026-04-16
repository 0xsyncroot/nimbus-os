// prompts.ts — SPEC-105: deterministic system prompt assembly with cache breakpoints.

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import type { CanonicalBlock, ProviderCapabilities } from '../ir/types.ts';
import type { WorkspaceMemory } from './memoryTypes.ts';
import type { TaskSpec } from './taskSpec.ts';
import {
  AUTONOMY_SECTION,
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
  taskSpec?: TaskSpec;
}

function textBlock(text: string, cache?: 'ephemeral'): CanonicalBlock {
  if (cache) return { type: 'text', text, cacheHint: cache };
  return { type: 'text', text };
}

export function buildSystemPrompt(input: BuildPromptInput): CanonicalBlock[] {
  const { memory, caps, planCue, environmentXml, taskSpec } = input;
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

  // 3-6. Static sections
  blocks.push(textBlock(AUTONOMY_SECTION));
  if (planCue && planCue.length > 0) {
    blocks.push(textBlock(`${planCue}\n`));
  }
  blocks.push(textBlock(SAFETY_SECTION));
  blocks.push(textBlock(UNTRUSTED_CONTENT_SECTION));
  blocks.push(textBlock(TOOL_USAGE_SECTION));

  // 7. MEMORY
  blocks.push(textBlock(`[MEMORY]\n${memory.memoryMd.body.trim()}\n`));

  // 7b. INTERNAL_PLAN — injected when a TaskSpec is present (SPEC-110 v2)
  if (taskSpec) {
    const outcomes = taskSpec.outcomes.length > 200
      ? taskSpec.outcomes.slice(0, 200) + '…'
      : taskSpec.outcomes;
    const actionLines = taskSpec.actions
      .slice(0, 5)
      .map((a) => `${a.tool}: ${a.reason}`)
      .join('\n');
    const planBlock = [
      '[INTERNAL_PLAN]',
      `outcomes: ${outcomes}`,
      actionLines.length > 0 ? `planned_actions:\n${actionLines}` : '',
      '',
      'Follow this plan by calling the listed tools. If a listed tool is unavailable in your tool schemas, state that clearly instead of silently skipping.',
    ].filter((l) => l !== '').join('\n');
    blocks.push(textBlock(`${planBlock}\n`));
  }

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
