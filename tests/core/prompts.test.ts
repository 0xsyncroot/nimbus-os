import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from '../../src/core/prompts.ts';
import { INJECTION_ORDER } from '../../src/core/promptSections.ts';
import type { WorkspaceMemory } from '../../src/core/memoryTypes.ts';
import type { ProviderCapabilities } from '../../src/ir/types.ts';

const FIX_MEMORY = (hasIdentity: boolean): WorkspaceMemory => ({
  soulMd: { frontmatter: {}, body: 'soul body', mtime: 0 },
  identityMd: hasIdentity ? { frontmatter: {}, body: 'identity body', mtime: 0 } : undefined,
  memoryMd: { frontmatter: {}, body: 'memory body', mtime: 0 },
  toolsMd: { frontmatter: {}, body: 'tools body', mtime: 0 },
  wsId: '01H0000000000000000000A000',
  loadedAt: 0,
});

const CAPS_EXPLICIT: ProviderCapabilities = {
  nativeTools: true,
  promptCaching: 'explicit',
  vision: 'base64',
  extendedThinking: false,
  maxContextTokens: 200000,
  supportsStreamingTools: true,
  supportsParallelTools: true,
};

const CAPS_IMPLICIT: ProviderCapabilities = { ...CAPS_EXPLICIT, promptCaching: 'implicit' };

describe('SPEC-105: prompt backbone', () => {
  test('idempotent output for same input', () => {
    const m = FIX_MEMORY(true);
    const a = buildSystemPrompt({ memory: m, caps: CAPS_EXPLICIT });
    const b = buildSystemPrompt({ memory: m, caps: CAPS_EXPLICIT });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('no identity → SOUL block present without identity', () => {
    const blocks = buildSystemPrompt({ memory: FIX_MEMORY(false), caps: CAPS_EXPLICIT });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('[SOUL]');
    expect(text).not.toContain('[IDENTITY]');
  });

  test('explicit caching places cacheHint markers', () => {
    const blocks = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT });
    const hints = blocks.filter((b) => b.type === 'text' && b.cacheHint === 'ephemeral').length;
    expect(hints).toBeGreaterThanOrEqual(2);
  });

  test('implicit caching strips cacheHint', () => {
    const blocks = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_IMPLICIT });
    for (const b of blocks) {
      if (b.type === 'text') expect(b.cacheHint).toBeUndefined();
    }
  });

  test('environment block appended when provided', () => {
    const blocks = buildSystemPrompt({
      memory: FIX_MEMORY(true),
      caps: CAPS_EXPLICIT,
      environmentXml: '<environment><cwd>/x</cwd></environment>',
    });
    const last = blocks[blocks.length - 1];
    expect(last?.type).toBe('text');
    if (last?.type === 'text') expect(last.text).toContain('[ENVIRONMENT]');
  });

  test('INJECTION_ORDER frozen', () => {
    expect(Object.isFrozen(INJECTION_ORDER)).toBe(true);
  });
});
