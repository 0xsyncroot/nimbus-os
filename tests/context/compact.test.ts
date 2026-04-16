// compact.test.ts — SPEC-120: tests for token estimation, compact prompt, boundary marker, circuit breaker.

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  roughTokenCount,
  effectiveWindow,
  messagesTokenCount,
  contextWindowFor,
  shouldAutoCompact,
  IMAGE_TOKEN_ESTIMATE,
  COMPACT_THRESHOLD,
} from '../../src/context/tokens.ts';
import {
  COMPACT_SYSTEM_PROMPT,
  formatCompactPrompt,
  formatCompactSummary,
  validateSummarySections,
  messagesToPlainText,
} from '../../src/context/compactPrompt.ts';
import {
  resetCompactCircuit,
  compactCircuitSnapshot,
  type CompactBoundaryMessage,
} from '../../src/context/compact.ts';
import type { CanonicalMessage } from '../../src/ir/types.ts';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe('SPEC-120: roughTokenCount', () => {
  test('empty string returns 0', () => {
    expect(roughTokenCount('')).toBe(0);
  });

  test('4-char string returns ~2 tokens (ceil(1 * 4/3))', () => {
    // 4 chars / 4 = 1 base; 1 * 4/3 = 1.33 → ceil = 2
    expect(roughTokenCount('abcd')).toBe(2);
  });

  test('100 chars returns correct estimate', () => {
    const text = 'a'.repeat(100);
    const base = 100 / 4; // 25
    const expected = Math.ceil(25 * (4 / 3)); // 34
    expect(roughTokenCount(text)).toBe(expected);
  });

  test('conservative padding always returns >= chars/4', () => {
    const text = 'hello world this is a test string';
    const naive = Math.floor(text.length / 4);
    expect(roughTokenCount(text)).toBeGreaterThanOrEqual(naive);
  });

  test('large text stays within <2ms (performance budget)', () => {
    const text = 'x'.repeat(100_000);
    const start = performance.now();
    roughTokenCount(text);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2);
  });
});

describe('SPEC-120: contextWindowFor', () => {
  test('returns 200K for claude-sonnet-4-5', () => {
    expect(contextWindowFor('claude-sonnet-4-5')).toBe(200_000);
  });

  test('returns 128K for gpt-4o', () => {
    expect(contextWindowFor('gpt-4o')).toBe(128_000);
  });

  test('returns 128K default for unknown model', () => {
    expect(contextWindowFor('unknown-model-xyz')).toBe(128_000);
  });

  test('prefix match works for versioned model IDs', () => {
    // claude-sonnet-4-5-20260416 should match claude-sonnet-4-5 prefix
    expect(contextWindowFor('claude-sonnet-4-5-20260416')).toBe(200_000);
  });
});

describe('SPEC-120: effectiveWindow', () => {
  test('effectiveWindow = contextWindow - min(maxOutput, 20K)', () => {
    // claude-opus-4: 200K context, default maxOutput = 20K → 180K
    expect(effectiveWindow('claude-opus-4')).toBe(180_000);
  });

  test('caps maxOutput at 20K', () => {
    // passing 50K maxOutput — should cap at 20K reserve
    expect(effectiveWindow('claude-opus-4', 50_000)).toBe(180_000);
  });

  test('small maxOutput is respected', () => {
    expect(effectiveWindow('claude-opus-4', 5_000)).toBe(195_000);
  });

  test('effectiveWindow for gpt-4o with default', () => {
    expect(effectiveWindow('gpt-4o')).toBe(108_000);
  });
});

describe('SPEC-120: messagesTokenCount', () => {
  test('returns 0 for empty array', () => {
    expect(messagesTokenCount([])).toBe(0);
  });

  test('counts text blocks correctly', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    ];
    const expected = roughTokenCount('hello') + roughTokenCount('world');
    expect(messagesTokenCount(msgs)).toBe(expected);
  });

  test('counts image blocks at flat 2000 tokens', () => {
    const msgs: CanonicalMessage[] = [
      {
        role: 'user',
        content: [{ type: 'image', source: { kind: 'base64', data: 'abc', mimeType: 'image/png' } }],
      },
    ];
    expect(messagesTokenCount(msgs)).toBe(IMAGE_TOKEN_ESTIMATE);
  });

  test('handles string content messages', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'system', content: 'you are a helpful assistant' },
    ];
    expect(messagesTokenCount(msgs)).toBe(roughTokenCount('you are a helpful assistant'));
  });
});

describe('SPEC-120: shouldAutoCompact', () => {
  test('returns false when well under threshold', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: 'hi' },
    ];
    expect(shouldAutoCompact(msgs, 'claude-opus-4')).toBe(false);
  });

  test('returns true when messages exceed 80% of effective window', () => {
    // effectiveWindow('claude-opus-4') = 180K tokens
    // Threshold = 180K * 0.8 = 144K
    // Create a message that is ~150K tokens → 150K * 4 * (3/4) = 450K chars
    const bigText = 'a'.repeat(450_000); // ~150K tokens
    const msgs: CanonicalMessage[] = [{ role: 'user', content: bigText }];
    expect(shouldAutoCompact(msgs, 'claude-opus-4')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compact prompt
// ---------------------------------------------------------------------------

describe('SPEC-120: formatCompactPrompt', () => {
  test('returns a non-empty string', () => {
    const result = formatCompactPrompt('some conversation');
    expect(result.length).toBeGreaterThan(0);
  });

  test('includes all 9 section names in the prompt', () => {
    const prompt = formatCompactPrompt('conversation');
    const sections = [
      'Primary Request and Intent',
      'Key Technical Concepts',
      'Files and Code Sections',
      'Errors and Fixes',
      'Problem Solving',
      'All User Messages',
      'Pending Tasks',
      'Current Work',
      'Optional Next Step',
    ];
    for (const section of sections) {
      expect(prompt).toContain(section);
    }
  });

  test('includes the conversation text', () => {
    const text = 'USER: fix the bug\nASSISTANT: sure';
    const prompt = formatCompactPrompt(text);
    expect(prompt).toContain(text);
  });
});

describe('SPEC-120: COMPACT_SYSTEM_PROMPT', () => {
  test('mentions analysis scratchpad', () => {
    expect(COMPACT_SYSTEM_PROMPT).toContain('<analysis>');
  });

  test('mentions summary block', () => {
    expect(COMPACT_SYSTEM_PROMPT).toContain('<summary>');
  });

  test('instructs no tool use', () => {
    expect(COMPACT_SYSTEM_PROMPT.toLowerCase()).toContain('do not use tools');
  });
});

describe('SPEC-120: formatCompactSummary', () => {
  test('extracts <summary> block, strips <analysis>', () => {
    const raw = `<analysis>
Some reasoning here.
</analysis>
<summary>
The actual summary content.
</summary>`;
    const result = formatCompactSummary(raw);
    expect(result).toBe('The actual summary content.');
    expect(result).not.toContain('<analysis>');
    expect(result).not.toContain('Some reasoning here.');
  });

  test('returns full text when no <summary> tags present', () => {
    const raw = 'Plain response without tags.';
    expect(formatCompactSummary(raw)).toBe(raw);
  });

  test('handles multiple <analysis> blocks', () => {
    const raw = '<analysis>a</analysis><analysis>b</analysis><summary>clean</summary>';
    expect(formatCompactSummary(raw)).toBe('clean');
  });
});

describe('SPEC-120: validateSummarySections', () => {
  test('ok when all 9 sections present', () => {
    const summary = [
      'Primary Request and Intent',
      'Key Technical Concepts',
      'Files and Code Sections',
      'Errors and Fixes',
      'Problem Solving',
      'All User Messages',
      'Pending Tasks',
      'Current Work',
      'Optional Next Step',
    ].join('\n');
    const result = validateSummarySections(summary);
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  test('reports missing sections', () => {
    const summary = 'Primary Request and Intent\nKey Technical Concepts';
    const result = validateSummarySections(summary);
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.missing).toContain('Files and Code Sections');
  });
});

describe('SPEC-120: messagesToPlainText', () => {
  test('formats text blocks with role labels', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ];
    const text = messagesToPlainText(msgs);
    expect(text).toContain('[USER]: hello');
    expect(text).toContain('[ASSISTANT]: hi there');
  });

  test('formats string content messages', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'system', content: 'system instructions' },
    ];
    const text = messagesToPlainText(msgs);
    expect(text).toContain('[SYSTEM]: system instructions');
  });
});

// ---------------------------------------------------------------------------
// Compact boundary marker
// ---------------------------------------------------------------------------

describe('SPEC-120: CompactBoundaryMessage shape', () => {
  test('boundary message has required fields', () => {
    const boundary: CompactBoundaryMessage = {
      type: 'compact_boundary',
      summary: 'test summary',
      metadata: {
        trigger: 'auto',
        preTokenCount: 1000,
        postTokenCount: 200,
      },
    };
    expect(boundary.type).toBe('compact_boundary');
    expect(boundary.metadata.trigger).toBe('auto');
    expect(boundary.metadata.preTokenCount).toBe(1000);
    expect(boundary.metadata.postTokenCount).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe('SPEC-120: compact circuit breaker', () => {
  beforeEach(() => {
    resetCompactCircuit();
  });

  test('starts with 0 failures and no open state', () => {
    const snap = compactCircuitSnapshot();
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.openUntil).toBe(0);
  });

  test('reset clears state', () => {
    // Simulate the internal state by calling reset
    resetCompactCircuit();
    const snap = compactCircuitSnapshot();
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.openUntil).toBe(0);
  });
});
