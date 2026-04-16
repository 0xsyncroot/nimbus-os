import { describe, expect, test } from 'bun:test';
import { consolidateMemory, isEligible, type SessionStats } from '../../src/context/memoryConsolidation.ts';
import type { CanonicalMessage } from '../../src/ir/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    workspaceId: 'ws-test',
    sessionId: 'ses-test',
    turns: 5,
    durationMs: 5 * 60_000, // 5 min
    costUsd: 0.01,
    ...overrides,
  };
}

function userMsg(text: string): CanonicalMessage {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): CanonicalMessage {
  return { role: 'assistant', content: text };
}

const EMPTY_MEMORY = '# Durable Facts\n\n(none yet)\n';

// ---------------------------------------------------------------------------
// SPEC-112: Dreaming Lite
// ---------------------------------------------------------------------------

describe('SPEC-112: memoryConsolidation — skip guards', () => {
  test('low_turns (<2) → skipped', () => {
    const result = consolidateMemory(
      [userMsg('hello'), assistantMsg('hi')],
      EMPTY_MEMORY,
      makeStats({ turns: 1 }),
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('low_turns');
    expect(result.newEntries).toHaveLength(0);
    expect(result.updatedMemory).toBe(EMPTY_MEMORY);
  });

  test('short_duration (<60s) → skipped', () => {
    const result = consolidateMemory(
      [userMsg('Decision: use TypeScript'), assistantMsg('noted')],
      EMPTY_MEMORY,
      makeStats({ durationMs: 30_000 }),
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('short_duration');
  });

  test('cost_cap (>=0.50) → skipped', () => {
    const result = consolidateMemory(
      [userMsg('Decision: use TypeScript')],
      EMPTY_MEMORY,
      makeStats({ costUsd: 0.50 }),
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('cost_cap');
  });
});

describe('SPEC-112: memoryConsolidation — candidate extraction', () => {
  test('extracts "Decision:" prefixed lines', () => {
    const msgs: CanonicalMessage[] = [
      userMsg('Decision: use Bun for the runtime'),
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.skipped).toBe(false);
    expect(result.newEntries).toContain('use Bun for the runtime');
  });

  test('extracts "Remember:" and "Preference:" lines', () => {
    const msgs: CanonicalMessage[] = [
      userMsg('Remember: always use pino not console.log'),
      userMsg('Preference: dark theme'),
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.newEntries).toContain('always use pino not console.log');
    expect(result.newEntries).toContain('dark theme');
  });

  test('extracts "Note:" prefix from assistant message', () => {
    const msgs: CanonicalMessage[] = [
      assistantMsg('Note: user wants strict TypeScript everywhere'),
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.newEntries).toContain('user wants strict TypeScript everywhere');
  });

  test('extracts assistant acknowledgement lines', () => {
    const msgs: CanonicalMessage[] = [
      assistantMsg("I'll remember to use pino for all logging."),
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.newEntries.length).toBeGreaterThan(0);
  });

  test('extracts user correction with "no, I meant"', () => {
    const msgs: CanonicalMessage[] = [
      userMsg('no, I meant the production database not staging'),
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.newEntries.length).toBeGreaterThan(0);
    expect(result.newEntries[0]).toContain('production database');
  });

  test('extracts Vietnamese "nhớ rằng" pattern', () => {
    const msgs: CanonicalMessage[] = [
      userMsg('nhớ rằng chúng ta dùng Bun, không phải Node'),
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.newEntries.length).toBeGreaterThan(0);
  });

  test('skips system messages', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'system', content: 'Decision: top-secret system directive' },
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.newEntries).toHaveLength(0);
  });

  test('handles CanonicalBlock array content', () => {
    const msgs: CanonicalMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Note: project uses Zod for schema validation' },
        ],
      },
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.newEntries).toContain('project uses Zod for schema validation');
  });
});

describe('SPEC-112: memoryConsolidation — deduplication', () => {
  test('does not add entry already in MEMORY.md (substring match)', () => {
    const existing = '# Durable Facts\n\n- use Bun for the runtime\n';
    const msgs: CanonicalMessage[] = [
      userMsg('Decision: use Bun for the runtime'),
    ];
    const result = consolidateMemory(msgs, existing, makeStats());
    expect(result.newEntries).toHaveLength(0);
  });

  test('does not add near-duplicate (high Jaccard similarity)', () => {
    const existing = '# Durable Facts\n\n- always use pino logger for logging output\n';
    const msgs: CanonicalMessage[] = [
      userMsg('Remember: always use pino logger for logging output in the project'),
    ];
    const result = consolidateMemory(msgs, existing, makeStats());
    // Should be deduped due to high word overlap
    expect(result.newEntries).toHaveLength(0);
  });

  test('does not add duplicate entries within the same session', () => {
    const msgs: CanonicalMessage[] = [
      userMsg('Decision: prefer functional style'),
      userMsg('Decision: prefer functional style'),
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.newEntries).toHaveLength(1);
  });
});

describe('SPEC-112: memoryConsolidation — append format', () => {
  test('appends under existing # Observations section', () => {
    const existing = '# Durable Facts\n\n(none)\n\n# Observations\n\n- old entry\n';
    const msgs: CanonicalMessage[] = [
      userMsg('Decision: use strict mode everywhere'),
    ];
    const result = consolidateMemory(msgs, existing, makeStats());
    expect(result.updatedMemory).toContain('# Observations');
    expect(result.updatedMemory).toContain('- use strict mode everywhere');
    // Old entry preserved
    expect(result.updatedMemory).toContain('- old entry');
    // Durable Facts untouched
    expect(result.updatedMemory).toContain('# Durable Facts');
  });

  test('creates # Observations section when absent', () => {
    const existing = '# Durable Facts\n\n(none)\n';
    const msgs: CanonicalMessage[] = [
      userMsg('Preference: always use camelCase'),
    ];
    const result = consolidateMemory(msgs, existing, makeStats());
    expect(result.updatedMemory).toContain('# Observations');
    expect(result.updatedMemory).toContain('- always use camelCase');
  });

  test('includes ## Session {date} header', () => {
    const msgs: CanonicalMessage[] = [
      userMsg('Note: deploy on Fridays is forbidden'),
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.updatedMemory).toMatch(/## Session \d{4}-\d{2}-\d{2}/);
  });

  test('entries formatted as bullet points', () => {
    const msgs: CanonicalMessage[] = [
      userMsg('Decision: use ULID for IDs'),
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.updatedMemory).toMatch(/^- use ULID for IDs$/m);
  });
});

describe('SPEC-112: memoryConsolidation — max 10 entries cap', () => {
  test('caps at 10 entries per session', () => {
    const msgs: CanonicalMessage[] = Array.from({ length: 20 }, (_, i) =>
      userMsg(`Decision: fact number ${i} is unique and important`),
    );
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.newEntries.length).toBeLessThanOrEqual(10);
  });
});

describe('SPEC-112: memoryConsolidation — empty / no-op cases', () => {
  test('empty message list → no entries, memory unchanged', () => {
    const result = consolidateMemory([], EMPTY_MEMORY, makeStats());
    expect(result.newEntries).toHaveLength(0);
    expect(result.updatedMemory).toBe(EMPTY_MEMORY);
    expect(result.skipped).toBe(false);
  });

  test('messages with no memorable patterns → no entries', () => {
    const msgs: CanonicalMessage[] = [
      userMsg('what is the capital of France?'),
      assistantMsg('Paris is the capital of France.'),
    ];
    const result = consolidateMemory(msgs, EMPTY_MEMORY, makeStats());
    expect(result.newEntries).toHaveLength(0);
    expect(result.updatedMemory).toBe(EMPTY_MEMORY);
  });
});

describe('SPEC-112: isEligible', () => {
  test('returns true when all thresholds met', () => {
    expect(isEligible({ turns: 5, durationMs: 5 * 60_000, costUsd: 0.1 })).toBe(true);
  });

  test('returns false below turn threshold', () => {
    expect(isEligible({ turns: 1, durationMs: 5 * 60_000, costUsd: 0.1 })).toBe(false);
  });

  test('returns false below duration threshold', () => {
    expect(isEligible({ turns: 5, durationMs: 10_000, costUsd: 0.1 })).toBe(false);
  });

  test('returns false at cost cap', () => {
    expect(isEligible({ turns: 5, durationMs: 5 * 60_000, costUsd: 0.50 })).toBe(false);
  });

  test('returns false above cost cap', () => {
    expect(isEligible({ turns: 5, durationMs: 5 * 60_000, costUsd: 0.99 })).toBe(false);
  });
});
