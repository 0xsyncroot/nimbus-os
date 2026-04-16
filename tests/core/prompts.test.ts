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

  // SPEC-132: taskSpec / INTERNAL_PLAN removed. Plan-as-tool replaces it.
  test('INTERNAL_PLAN block never present (SPEC-132 removed it)', () => {
    const sys = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT });
    const text = sys.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).not.toContain('[INTERNAL_PLAN]');
  });

  // SPEC-122: SESSION_PREFS block injection
  test('SESSION_PREFS block injected when sessionPrefs non-empty', () => {
    const sys = buildSystemPrompt({
      memory: FIX_MEMORY(true),
      caps: CAPS_EXPLICIT,
      sessionPrefs: { agentName: 'Nimbus', language: 'vi' },
    });
    const text = sys.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('[SESSION_PREFS]');
    expect(text).toContain('agentName: Nimbus');
    expect(text).toContain('language: vi');
  });

  test('SESSION_PREFS block absent when sessionPrefs empty', () => {
    const sys = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT });
    const text = sys.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).not.toContain('[SESSION_PREFS]');
  });

  test('SESSION_PREFS block placed after IDENTITY and before AUTONOMY', () => {
    const sys = buildSystemPrompt({
      memory: FIX_MEMORY(true),
      caps: CAPS_EXPLICIT,
      sessionPrefs: { agentName: 'TestAgent' },
    });
    const text = sys.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const idxIdentity = text.indexOf('[IDENTITY]');
    const idxPrefs = text.indexOf('[SESSION_PREFS]');
    const idxAutonomy = text.indexOf('[AUTONOMY]');
    expect(idxIdentity).toBeLessThan(idxPrefs);
    expect(idxPrefs).toBeLessThan(idxAutonomy);
  });
});

// SPEC-124: credential-handling section
describe('SPEC-124: credential handling prompt section', () => {
  test('buildSystemPrompt contains [CREDENTIAL_HANDLING] header', () => {
    const text = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    expect(text).toContain('[CREDENTIAL_HANDLING]');
  });

  test('CREDENTIAL_HANDLING contains anti-pattern fence', () => {
    const text = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    expect(text).toContain('Anti-pattern');
    expect(text).toContain('Do NOT produce');
  });

  test('CREDENTIAL_HANDLING contains "save to vault" instruction', () => {
    const text = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    expect(text).toContain('vault');
    expect(text).toContain('configuration intent');
  });

  test('CREDENTIAL_HANDLING placed after AUTONOMY and before SAFETY', () => {
    const text = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    const idxAutonomy = text.indexOf('[AUTONOMY]');
    const idxCred = text.indexOf('[CREDENTIAL_HANDLING]');
    const idxSafety = text.indexOf('[SAFETY]');
    expect(idxAutonomy).toBeLessThan(idxCred);
    expect(idxCred).toBeLessThan(idxSafety);
  });

  test('uses placeholder token shape (no real tokens)', () => {
    const text = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    expect(text).toContain('NNNNNNNNNN:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });
});

// SPEC-123: action-first bias
describe('SPEC-123: action-first bias', () => {
  test('AUTONOMY_SECTION contains "bias toward action"', () => {
    const text = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    expect(text).toContain('bias toward action');
  });

  test('AUTONOMY_SECTION contains anti-pattern fence', () => {
    const text = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    expect(text).toContain('Anti-pattern');
    expect(text).toContain('Do NOT produce');
  });

  test('injection order: SOUL < IDENTITY < AUTONOMY < SAFETY < UNTRUSTED_CONTENT < TOOL_USAGE < MEMORY < TOOLS_AVAILABLE', () => {
    const text = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    const positions = [
      '[SOUL]',
      '[IDENTITY]',
      '[AUTONOMY]',
      '[SAFETY]',
      '[UNTRUSTED_CONTENT]',
      '[TOOL_USAGE]',
      '[MEMORY]',
      '[TOOLS_AVAILABLE]',
    ].map((tag) => text.indexOf(tag));
    for (let i = 0; i < positions.length - 1; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual(0);
      expect(positions[i]!).toBeLessThan(positions[i + 1]!);
    }
  });

  // SPEC-124: full injection order including SESSION_PREFS + CREDENTIAL_HANDLING
  test('injection order: SOUL → IDENTITY → SESSION_PREFS → AUTONOMY → CREDENTIAL_HANDLING → SAFETY → UNTRUSTED_CONTENT → TOOL_USAGE → MEMORY → TOOLS_AVAILABLE', () => {
    const text = buildSystemPrompt({
      memory: FIX_MEMORY(true),
      caps: CAPS_EXPLICIT,
      sessionPrefs: { agentName: 'Nimbus' },
    })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    const tags = [
      '[SOUL]',
      '[IDENTITY]',
      '[SESSION_PREFS]',
      '[AUTONOMY]',
      '[CREDENTIAL_HANDLING]',
      '[SAFETY]',
      '[UNTRUSTED_CONTENT]',
      '[TOOL_USAGE]',
      '[MEMORY]',
      '[TOOLS_AVAILABLE]',
    ];
    const positions = tags.map((tag) => text.indexOf(tag));
    for (let i = 0; i < positions.length - 1; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual(0);
      expect(positions[i]!).toBeLessThan(positions[i + 1]!);
    }
  });

  test('system prompt stays under 32KB', () => {
    const text = buildSystemPrompt({ memory: FIX_MEMORY(true), caps: CAPS_EXPLICIT })
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(32 * 1024);
  });
});
