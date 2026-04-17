// collapse.test.ts — SPEC-845: Collapsed Read/Search coalescing and ToolUseLoader.
// Tests: collapseReadSearch algorithm, CollapsedReadSearch render, ToolUseLoader elapsed.

import { describe, test, expect, afterEach } from 'bun:test';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { App } from '../../../../src/channels/cli/ink/app.tsx';

// ── Imports under test ────────────────────────────────────────────────────────

import {
  collapseReadSearch,
  COLLAPSIBLE_TOOLS,
} from '../../../../src/channels/cli/ink/utils/collapseReadSearch.ts';
import type {
  ToolEvent,
  CoalescedGroup,
} from '../../../../src/channels/cli/ink/utils/collapseReadSearch.ts';

import { CollapsedReadSearch } from '../../../../src/channels/cli/ink/components/CollapsedReadSearch.tsx';
import {
  ToolUseLoader,
  formatElapsed,
} from '../../../../src/channels/cli/ink/components/ToolUseLoader.tsx';

// ── App wrapper ────────────────────────────────────────────────────────────────

const WORKSPACE = {
  id: '01HXR7K2XNPKMWQ8T3VDSY41GJ',
  name: 'test-ws',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
} as const;

function wrapApp(
  children: React.ReactNode,
  opts: { locale?: 'en' | 'vi'; noColor?: boolean } = {},
): React.ReactElement {
  return React.createElement(App, {
    workspace: WORKSPACE,
    mode: 'default',
    locale: opts.locale ?? 'en',
    reducedMotion: false,
    noColor: opts.noColor ?? false,
    themeName: 'dark',
    children,
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeRead(path: string = '/tmp/file.ts'): ToolEvent {
  return { toolName: 'Read', args: { path } };
}

function makeGrep(pattern: string, matchCount: number = 0): ToolEvent {
  return {
    toolName: 'Grep',
    args: { pattern },
    result: { matchCount },
  };
}

function makeGlob(pattern: string): ToolEvent {
  return { toolName: 'Glob', args: { pattern } };
}

function makeBash(command: string = 'ls'): ToolEvent {
  return { toolName: 'Bash', args: { command } };
}

afterEach(() => cleanup());

// ─────────────────────────────────────────────────────────────────────────────
// SPEC-845: collapseReadSearch algorithm
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC-845: collapseReadSearch algorithm', () => {
  test('empty input returns empty array', () => {
    expect(collapseReadSearch([])).toEqual([]);
  });

  test('COLLAPSIBLE_TOOLS contains Read, Grep, Glob', () => {
    expect(COLLAPSIBLE_TOOLS).toContain('Read');
    expect(COLLAPSIBLE_TOOLS).toContain('Grep');
    expect(COLLAPSIBLE_TOOLS).toContain('Glob');
  });

  test('3x Read + 1x Grep → 1 collapsed group', () => {
    const events: ToolEvent[] = [
      makeRead('/a.ts'),
      makeRead('/b.ts'),
      makeRead('/c.ts'),
      makeGrep('foo', 12),
    ];
    const result = collapseReadSearch(events);
    expect(result).toHaveLength(1);
    const group = result[0] as CoalescedGroup;
    expect(group.type).toBe('read-search');
    expect(group.fileCount).toBe(3);
    expect(group.searchTerms).toContain('foo');
    expect(group.matchCount).toBe(12);
    expect(group.events).toHaveLength(4);
  });

  test('Read → Bash → Read does NOT coalesce across Bash (2 separate groups)', () => {
    const events: ToolEvent[] = [
      makeRead('/a.ts'),
      makeBash('ls'),
      makeRead('/b.ts'),
    ];
    const result = collapseReadSearch(events);
    expect(result).toHaveLength(3);
    const g1 = result[0] as CoalescedGroup;
    const bash = result[1] as ToolEvent;
    const g2 = result[2] as CoalescedGroup;
    expect(g1.type).toBe('read-search');
    expect(g1.fileCount).toBe(1);
    expect(bash.toolName).toBe('Bash');
    expect(g2.type).toBe('read-search');
    expect(g2.fileCount).toBe(1);
  });

  test('Grep match count is included in summary', () => {
    const events: ToolEvent[] = [makeGrep('bar', 7)];
    const result = collapseReadSearch(events);
    expect(result).toHaveLength(1);
    const group = result[0] as CoalescedGroup;
    expect(group.matchCount).toBe(7);
  });

  test('multiple Grep events accumulate match counts', () => {
    const events: ToolEvent[] = [makeGrep('x', 3), makeGrep('y', 5)];
    const result = collapseReadSearch(events);
    expect(result).toHaveLength(1);
    const group = result[0] as CoalescedGroup;
    expect(group.matchCount).toBe(8);
    expect(group.searchTerms).toEqual(['x', 'y']);
  });

  test('Glob patterns are captured in searchTerms', () => {
    const events: ToolEvent[] = [makeGlob('**/*.ts'), makeGlob('src/**/*.tsx')];
    const result = collapseReadSearch(events);
    expect(result).toHaveLength(1);
    const group = result[0] as CoalescedGroup;
    expect(group.searchTerms).toContain('**/*.ts');
    expect(group.searchTerms).toContain('src/**/*.tsx');
  });

  test('non-collapsible tool between reads splits into 3 items', () => {
    const events: ToolEvent[] = [
      makeRead('/a.ts'),
      { toolName: 'Edit', args: { path: '/a.ts' } },
      makeRead('/b.ts'),
    ];
    const result = collapseReadSearch(events);
    expect(result).toHaveLength(3);
  });

  test('single Read produces 1 group with fileCount=1', () => {
    const result = collapseReadSearch([makeRead('/f.ts')]);
    expect(result).toHaveLength(1);
    const group = result[0] as CoalescedGroup;
    expect(group.fileCount).toBe(1);
    expect(group.searchTerms).toHaveLength(0);
    expect(group.matchCount).toBe(0);
  });

  test('single Bash passes through as raw ToolEvent', () => {
    const bash = makeBash('echo hi');
    const result = collapseReadSearch([bash]);
    expect(result).toHaveLength(1);
    expect((result[0] as ToolEvent).toolName).toBe('Bash');
  });

  test('O(n) algorithm: 100 events collapse correctly', () => {
    const events: ToolEvent[] = Array.from({ length: 100 }, (_, i) =>
      makeRead(`/file-${i}.ts`),
    );
    const start = Date.now();
    const result = collapseReadSearch(events);
    const elapsed = Date.now() - start;
    expect(result).toHaveLength(1);
    const group = result[0] as CoalescedGroup;
    expect(group.fileCount).toBe(100);
    expect(elapsed).toBeLessThan(10); // well within 1ms budget
  });

  test('duplicate search terms are deduplicated', () => {
    const events: ToolEvent[] = [makeGrep('foo', 2), makeGrep('foo', 3)];
    const result = collapseReadSearch(events);
    const group = result[0] as CoalescedGroup;
    // 'foo' should appear only once
    expect(group.searchTerms.filter((t) => t === 'foo')).toHaveLength(1);
    expect(group.matchCount).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC-845: CollapsedReadSearch component
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC-845: CollapsedReadSearch component', () => {
  test('renders "Read 3 files, searched \'foo\' → 12 matches" (en)', () => {
    const group: CoalescedGroup = {
      type: 'read-search',
      fileCount: 3,
      searchTerms: ['foo'],
      matchCount: 12,
      events: [],
    };
    const { lastFrame } = render(
      wrapApp(React.createElement(CollapsedReadSearch, { group }), {
        locale: 'en',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Read 3 files');
    expect(frame).toContain("'foo'");
    expect(frame).toContain('12 matches');
  });

  test('renders Vietnamese variant (vi)', () => {
    const group: CoalescedGroup = {
      type: 'read-search',
      fileCount: 2,
      searchTerms: ['bar'],
      matchCount: 5,
      events: [],
    };
    const { lastFrame } = render(
      wrapApp(React.createElement(CollapsedReadSearch, { group }), {
        locale: 'vi',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Đọc');
    expect(frame).toContain('tệp');
    expect(frame).toContain("'bar'");
    expect(frame).toContain('kết quả');
  });

  test('singular file/match labels (en)', () => {
    const group: CoalescedGroup = {
      type: 'read-search',
      fileCount: 1,
      searchTerms: ['baz'],
      matchCount: 1,
      events: [],
    };
    const { lastFrame } = render(
      wrapApp(React.createElement(CollapsedReadSearch, { group })),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 file');
    expect(frame).toContain('1 match');
    // Should NOT say "1 files" or "1 matches"
    expect(frame).not.toContain('1 files');
    expect(frame).not.toContain('1 matches');
  });

  test('no-emoji text token in noColor mode', () => {
    const group: CoalescedGroup = {
      type: 'read-search',
      fileCount: 2,
      searchTerms: [],
      matchCount: 0,
      events: [],
    };
    const { lastFrame } = render(
      wrapApp(React.createElement(CollapsedReadSearch, { group }), {
        noColor: true,
      }),
    );
    const frame = lastFrame() ?? '';
    // noColor mode should use text token [R] instead of emoji
    expect(frame).toContain('[R]');
    expect(frame).not.toContain('📖');
  });

  test('renders without crash when no search terms', () => {
    const group: CoalescedGroup = {
      type: 'read-search',
      fileCount: 4,
      searchTerms: [],
      matchCount: 0,
      events: [],
    };
    const { lastFrame } = render(
      wrapApp(React.createElement(CollapsedReadSearch, { group })),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Read 4 files');
    // No search part when no terms
    expect(frame).not.toContain('searched');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC-845: formatElapsed helper
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC-845: formatElapsed', () => {
  test('5000ms → "00:05"', () => {
    expect(formatElapsed(5000)).toBe('00:05');
  });

  test('0ms → "00:00"', () => {
    expect(formatElapsed(0)).toBe('00:00');
  });

  test('65000ms → "01:05"', () => {
    expect(formatElapsed(65000)).toBe('01:05');
  });

  test('3600000ms (1h) → "60:00"', () => {
    expect(formatElapsed(3600000)).toBe('60:00');
  });

  test('negative ms clamps to "00:00"', () => {
    expect(formatElapsed(-500)).toBe('00:00');
  });

  test('59999ms → "00:59"', () => {
    expect(formatElapsed(59999)).toBe('00:59');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC-845: ToolUseLoader component
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC-845: ToolUseLoader component', () => {
  test('renders tool name as verb', () => {
    const startedAt = Date.now() - 2000;
    const { lastFrame } = render(
      wrapApp(
        React.createElement(ToolUseLoader, { toolName: 'Bash', startedAt }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Bash');
  });

  test('renders elapsed mm:ss', () => {
    const startedAt = Date.now() - 5000;
    const { lastFrame } = render(
      wrapApp(
        React.createElement(ToolUseLoader, { toolName: 'Bash', startedAt }),
      ),
    );
    const frame = lastFrame() ?? '';
    // Should show elapsed time in mm:ss format
    expect(frame).toMatch(/\d{2}:\d{2}/);
  });

  test('renders without throw for WebFetch', () => {
    const startedAt = Date.now();
    expect(() => {
      const { unmount } = render(
        wrapApp(
          React.createElement(ToolUseLoader, {
            toolName: 'WebFetch',
            startedAt,
          }),
        ),
      );
      unmount();
    }).not.toThrow();
  });

  test('unmount clears interval (no memory leak)', () => {
    const originalClearInterval = global.clearInterval;
    let clearIntervalCallCount = 0;
    global.clearInterval = (id: unknown) => {
      clearIntervalCallCount++;
      return originalClearInterval(id as ReturnType<typeof setInterval>);
    };

    const startedAt = Date.now();
    const { unmount } = render(
      wrapApp(
        React.createElement(ToolUseLoader, { toolName: 'Bash', startedAt }),
      ),
    );
    unmount();

    expect(clearIntervalCallCount).toBeGreaterThanOrEqual(1);
    global.clearInterval = originalClearInterval;
  });
});
