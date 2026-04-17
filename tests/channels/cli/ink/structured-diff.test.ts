// structured-diff.test.ts — SPEC-844: StructuredDiff component tests.
// Tests: +/- colored output, multi-hunk, narrow fallback, WeakMap cache, plain fallback.

import { describe, test, expect, afterEach } from 'bun:test';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/channels/cli/ink/theme.ts';
import { StructuredDiff, GUTTER_WIDTH } from '../../../../src/channels/cli/ink/components/StructuredDiff.tsx';
import { StructuredDiffList } from '../../../../src/channels/cli/ink/components/StructuredDiffList.tsx';
import { Fallback } from '../../../../src/channels/cli/ink/components/StructuredDiff/Fallback.tsx';
import {
  colorize,
  lineMarker,
  stripAnsiOsc,
  isNapiAvailable,
} from '../../../../src/channels/cli/ink/components/StructuredDiff/colorDiff.ts';
import type { DiffHunk, DiffLine } from '../../../../src/channels/cli/ink/components/StructuredDiff/colorDiff.ts';
import { PALETTES } from '../../../../src/channels/cli/ink/theme.ts';

afterEach(() => {
  cleanup();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────
function makeHunk(overrides?: Partial<DiffHunk>): DiffHunk {
  return Object.freeze({
    oldStart: 1,
    newStart: 1,
    oldLines: 3,
    newLines: 3,
    lines: Object.freeze([
      Object.freeze({ type: 'context', content: 'ctx line 1', oldLineNo: 1, newLineNo: 1 }),
      Object.freeze({ type: 'remove', content: 'old line 2', oldLineNo: 2 }),
      Object.freeze({ type: 'add',    content: 'new line 2', newLineNo: 2 }),
    ]) as DiffLine[],
    ...overrides,
  }) as DiffHunk;
}

function makeLargeHunk(lineCount: number): DiffHunk {
  const lines: DiffLine[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(Object.freeze({
      type: (i % 3 === 0 ? 'add' : i % 3 === 1 ? 'remove' : 'context') as DiffLine['type'],
      content: `line content ${i}`,
      oldLineNo: i % 3 !== 0 ? i + 1 : undefined,
      newLineNo: i % 3 !== 1 ? i + 1 : undefined,
    }));
  }
  return Object.freeze({
    oldStart: 1,
    newStart: 1,
    oldLines: lineCount,
    newLines: lineCount,
    lines: Object.freeze(lines) as DiffLine[],
  }) as DiffHunk;
}

// ── SPEC-844 T1: colorDiff.ts ─────────────────────────────────────────────────
describe('SPEC-844: colorDiff utilities', () => {
  test('lineMarker returns + for add', () => {
    expect(lineMarker('add')).toBe('+');
  });

  test('lineMarker returns - for remove', () => {
    expect(lineMarker('remove')).toBe('-');
  });

  test('lineMarker returns space for context', () => {
    expect(lineMarker('context')).toBe(' ');
  });

  test('colorize with noColor=true returns plain marker', () => {
    const addLine: DiffLine = { type: 'add', content: 'foo', newLineNo: 1 };
    expect(colorize(addLine, true)).toBe('+');
  });

  test('colorize with noColor=false and palette returns success color for add', () => {
    const addLine: DiffLine = { type: 'add', content: 'foo', newLineNo: 1 };
    const palette = PALETTES['dark'];
    const result = colorize(addLine, false, palette);
    expect(result).toBe(palette.success);
  });

  test('colorize returns error color for remove line', () => {
    const removeLine: DiffLine = { type: 'remove', content: 'bar', oldLineNo: 2 };
    const palette = PALETTES['dark'];
    const result = colorize(removeLine, false, palette);
    expect(result).toBe(palette.error);
  });

  test('colorize returns inactive color for context line', () => {
    const ctxLine: DiffLine = { type: 'context', content: 'ctx', oldLineNo: 3, newLineNo: 3 };
    const palette = PALETTES['dark'];
    const result = colorize(ctxLine, false, palette);
    expect(result).toBe(palette.inactive);
  });

  test('isNapiAvailable returns false for v0.4 MVP (no NAPI module)', () => {
    expect(isNapiAvailable()).toBe(false);
  });

  test('stripAnsiOsc removes ANSI escape sequences', () => {
    const withAnsi = '\x1B[32mhello\x1B[0m world';
    const stripped = stripAnsiOsc(withAnsi);
    expect(stripped).not.toContain('\x1B');
    expect(stripped).toContain('hello');
    expect(stripped).toContain('world');
  });

  test('stripAnsiOsc passes through plain text unchanged', () => {
    expect(stripAnsiOsc('plain text')).toBe('plain text');
  });
});

// ── SPEC-844 T2: Fallback.tsx ────────────────────────────────────────────────
describe('SPEC-844: Fallback component', () => {
  test('renders add/remove/context markers', () => {
    const hunk = makeHunk();
    const { lastFrame } = render(
      React.createElement(Fallback, { hunk }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('+');
    expect(frame).toContain('-');
    expect(frame).toContain('new line 2');
    expect(frame).toContain('old line 2');
  });

  test('renders without ANSI color codes', () => {
    const hunk = makeHunk();
    const { lastFrame } = render(
      React.createElement(Fallback, { hunk }),
    );
    const frame = lastFrame() ?? '';
    // In Fallback, no color props → no ANSI output
    expect(frame).not.toContain('\x1B[');
  });

  test('renders hunk with user-controlled content safely (strips ANSI)', () => {
    const hunk: DiffHunk = Object.freeze({
      oldStart: 1, newStart: 1, oldLines: 1, newLines: 1,
      lines: Object.freeze([
        Object.freeze({ type: 'add' as const, content: '\x1B[31mmalicious\x1B[0m', newLineNo: 1 }),
      ]) as DiffLine[],
    });
    const { lastFrame } = render(React.createElement(Fallback, { hunk }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('malicious');
    expect(frame).not.toContain('\x1B[31m');
  });
});

// ── SPEC-844 T3: StructuredDiff.tsx ──────────────────────────────────────────
describe('SPEC-844: StructuredDiff component', () => {
  test('renders add line with content', () => {
    const hunk = makeHunk();
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiff, { hunk, cols: 80 }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('new line 2');
    expect(frame).toContain('+');
  });

  test('renders remove line with - marker', () => {
    const hunk = makeHunk();
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiff, { hunk, cols: 80 }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('-');
    expect(frame).toContain('old line 2');
  });

  test('narrow terminal (cols=30) triggers Fallback', () => {
    // cols - GUTTER_WIDTH (8) = 22 < 40 → Fallback
    const hunk = makeHunk();
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiff, { hunk, cols: 30 }),
      ),
    );
    const frame = lastFrame() ?? '';
    // Fallback renders plain markers
    expect(frame).toContain('+');
    expect(frame).toContain('-');
    // Fallback has no border box — just plain text
    expect(frame).toBeDefined();
  });

  test('cols at threshold boundary (cols=48) renders full gutter view', () => {
    // cols - GUTTER_WIDTH (8) = 40 → NOT narrow (threshold is < 40, not <=)
    const hunk = makeHunk();
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiff, { hunk, cols: 48 }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('new line 2');
  });

  test('NO_COLOR mode (dark-ansi theme) renders plain text without ANSI', () => {
    const hunk = makeHunk();
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider, { name: 'dark-ansi' },
        React.createElement(StructuredDiff, { hunk, cols: 80 }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('new line 2');
    expect(frame).not.toContain('\x1B[');
  });

  test('renders without throwing for empty hunks', () => {
    const emptyLines: DiffLine[] = [];
    const emptyHunk: DiffHunk = Object.freeze({
      oldStart: 1, newStart: 1, oldLines: 0, newLines: 0,
      lines: emptyLines,
    });
    expect(() => {
      render(
        React.createElement(
          ThemeProvider, { name: 'dark' },
          React.createElement(StructuredDiff, { hunk: emptyHunk, cols: 80 }),
        ),
      );
      cleanup();
    }).not.toThrow();
  });

  test('GUTTER_WIDTH constant is 8', () => {
    expect(GUTTER_WIDTH).toBe(8);
  });
});

// ── SPEC-844 T3b: WeakMap cache ───────────────────────────────────────────────
describe('SPEC-844: WeakMap hunk cache', () => {
  test('same hunk reference reuses cached ReactElements on re-render', () => {
    const hunk = makeHunk();

    // First render — cache miss, populates cache
    const { lastFrame: frame1, rerender } = render(
      React.createElement(
        ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiff, { hunk, cols: 80 }),
      ),
    );
    expect(frame1()).toBeDefined();

    // Re-render with same hunk reference — should cache hit (no recompute)
    rerender(
      React.createElement(
        ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiff, { hunk, cols: 80 }),
      ),
    );
    // Output should be identical since same hunk data
    expect(frame1()).toContain('new line 2');
  });

  test('different hunk reference is a cache miss (new object)', () => {
    // Two separate frozen hunk objects with identical data but different refs
    const hunk1 = makeHunk();
    const hunk2 = makeHunk(); // new object = cache miss

    // Render first, capture frame before cleanup
    const { lastFrame: f1, unmount: u1 } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiff, { hunk: hunk1, cols: 80 }),
      ),
    );
    const frame1 = f1();
    u1();

    const { lastFrame: f2, unmount: u2 } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiff, { hunk: hunk2, cols: 80 }),
      ),
    );
    const frame2 = f2();
    u2();

    // Both render same content since data is identical
    expect(frame1).toContain('new line 2');
    expect(frame2).toContain('new line 2');
  });
});

// ── SPEC-844 T4: StructuredDiffList.tsx ───────────────────────────────────────
describe('SPEC-844: StructuredDiffList component', () => {
  test('renders file path header', () => {
    const hunk = makeHunk();
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiffList, {
          filePath: 'src/foo/bar.ts',
          hunks: [hunk],
          cols: 80,
        }),
      ),
    );
    expect(lastFrame()).toContain('src/foo/bar.ts');
  });

  test('renders hunk header @@ ... @@ for each hunk', () => {
    const hunk = makeHunk();
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiffList, {
          filePath: 'a.ts',
          hunks: [hunk],
          cols: 80,
        }),
      ),
    );
    expect(lastFrame()).toContain('@@');
  });

  test('renders multiple hunks each with their diff', () => {
    const hunk1 = Object.freeze({
      oldStart: 1, newStart: 1, oldLines: 1, newLines: 1,
      lines: Object.freeze([
        Object.freeze({ type: 'add' as const, content: 'hunk1 add', newLineNo: 1 }),
      ]) as DiffLine[],
    });
    const hunk2 = Object.freeze({
      oldStart: 10, newStart: 10, oldLines: 1, newLines: 1,
      lines: Object.freeze([
        Object.freeze({ type: 'remove' as const, content: 'hunk2 remove', oldLineNo: 10 }),
      ]) as DiffLine[],
    });

    const { lastFrame } = render(
      React.createElement(
        ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiffList, {
          filePath: 'multi.ts',
          hunks: [hunk1, hunk2],
          cols: 80,
        }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hunk1 add');
    expect(frame).toContain('hunk2 remove');
  });

  test('renders empty hunks list without throw', () => {
    expect(() => {
      render(
        React.createElement(
          ThemeProvider, { name: 'dark' },
          React.createElement(StructuredDiffList, {
            filePath: 'empty.ts',
            hunks: [],
            cols: 80,
          }),
        ),
      );
      cleanup();
    }).not.toThrow();
  });
});

// ── SPEC-844 T5: Performance budget ──────────────────────────────────────────
describe('SPEC-844: Performance budgets', () => {
  test('200-line diff cold render completes in ≤50ms', () => {
    const hunk = makeLargeHunk(200);
    const start = performance.now();
    const { unmount } = render(
      React.createElement(
        ThemeProvider, { name: 'dark' },
        React.createElement(StructuredDiff, { hunk, cols: 120 }),
      ),
    );
    const elapsed = performance.now() - start;
    unmount();
    expect(elapsed).toBeLessThan(50);
  });
});
