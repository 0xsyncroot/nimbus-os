// streaming.test.ts — SPEC-843: Streaming output render suite.
// Tests: markdown cache, fast-path skip, spinner frames, stall color,
//        reduced-motion, ANSI stripper, MAX_STATIC_BLOCKS eviction, tool glyphs.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/channels/cli/ink/theme.ts';
import { App } from '../../../../src/channels/cli/ink/app.tsx';

// ── Markdown cache / fast-path ────────────────────────────────────────────────
import {
  stripAnsiOsc,
  hasMdSyntax,
  renderMarkdown,
  clearMarkdownCache,
  markdownCacheSize,
  Markdown,
} from '../../../../src/channels/cli/ink/components/Markdown.tsx';

// ── SpinnerWithVerb ────────────────────────────────────────────────────────────
import {
  lerpColor,
  FRAME_INTERVAL_MS,
  STALL_THRESHOLD_MS,
  REDUCED_MOTION_CYCLE_MS,
  SpinnerWithVerb,
} from '../../../../src/channels/cli/ink/components/SpinnerWithVerb.tsx';

// ── Figures / glyphs ──────────────────────────────────────────────────────────
import {
  TOOL_USE_GLYPH,
  BULLET_GLYPH,
  SPINNER_FRAMES,
  SPINNER_FRAMES_PINGPONG,
} from '../../../../src/channels/cli/ink/constants/figures.ts';

// ── Static blocks helper ─────────────────────────────────────────────────────
import {
  addStaticBlock,
  MAX_STATIC_BLOCKS,
} from '../../../../src/channels/cli/ink/components/AssistantMessage.tsx';

// ── ToolUseMessage ────────────────────────────────────────────────────────────
import {
  ToolUseMessage,
  registerToolRenderer,
} from '../../../../src/channels/cli/ink/components/ToolUseMessage.tsx';

// ── App wrapper for components that need context ──────────────────────────────
const WORKSPACE = {
  id: '01HXR7K2XNPKMWQ8T3VDSY41GJ',
  name: 'test-ws',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
} as const;

const MODE = 'default' as const;

function wrapApp(
  children: React.ReactNode,
  opts: { reducedMotion?: boolean; noColor?: boolean } = {},
): React.ReactElement {
  return React.createElement(App, {
    workspace: WORKSPACE,
    mode: MODE,
    locale: 'en',
    reducedMotion: opts.reducedMotion ?? false,
    noColor: opts.noColor ?? false,
    themeName: 'dark',
    children,
  });
}

afterEach(() => {
  cleanup();
  clearMarkdownCache();
});

// ── SPEC-843: ANSI/OSC stripper ───────────────────────────────────────────────
describe('SPEC-843: ANSI/OSC stripper', () => {
  test('strips CSI SGR sequences', () => {
    expect(stripAnsiOsc('hello \x1b[32mworld\x1b[0m')).toBe('hello world');
  });

  test('strips cursor-position report \\x1b[6n', () => {
    expect(stripAnsiOsc('hello \x1b[2J\x1b[6n world')).toBe('hello  world');
  });

  test('strips OSC sequences ending with BEL', () => {
    expect(stripAnsiOsc('text\x1b]0;title\x07end')).toBe('textend');
  });

  test('strips C1 control sequences \\x9b', () => {
    expect(stripAnsiOsc('a\x9b1mb')).toBe('ab');
  });

  test('leaves plain text unchanged', () => {
    expect(stripAnsiOsc('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(stripAnsiOsc('')).toBe('');
  });

  test('handles multiple sequences in one string', () => {
    const result = stripAnsiOsc('\x1b[1;31mred\x1b[0m and \x1b[32mgreen\x1b[0m');
    expect(result).toBe('red and green');
  });
});

// ── SPEC-843: Markdown fast-path ──────────────────────────────────────────────
describe('SPEC-843: Markdown fast-path (hasMdSyntax)', () => {
  test('returns false for plain prose', () => {
    expect(hasMdSyntax('Hello, this is plain prose without any markdown syntax.')).toBe(false);
  });

  test('returns true for text with # header', () => {
    expect(hasMdSyntax('# Hello')).toBe(true);
  });

  test('returns true for text with ** bold', () => {
    expect(hasMdSyntax('This is **bold** text')).toBe(true);
  });

  test('returns true for text with backtick code', () => {
    expect(hasMdSyntax('Use `code` here')).toBe(true);
  });

  test('returns true for text with blank-line paragraph break', () => {
    expect(hasMdSyntax('Para one\n\nPara two')).toBe(true);
  });

  test('returns true for ordered list', () => {
    expect(hasMdSyntax('1. First item\n2. Second item')).toBe(true);
  });

  test('only checks first 500 chars', () => {
    // 600 chars of plain text followed by a markdown marker
    const longPlain = 'a'.repeat(600) + '# header';
    expect(hasMdSyntax(longPlain)).toBe(false);
  });
});

// ── SPEC-843: Markdown LRU cache ─────────────────────────────────────────────
describe('SPEC-843: Markdown LRU cache', () => {
  beforeEach(() => clearMarkdownCache());

  test('cache hit on second render of same content', () => {
    const md = '# Hello\n\nThis is **markdown**.';
    const first = renderMarkdown(md);
    const sizeBefore = markdownCacheSize();
    const second = renderMarkdown(md);
    const sizeAfter = markdownCacheSize();
    expect(first).toBe(second);
    // Cache size should not grow on hit
    expect(sizeAfter).toBe(sizeBefore);
  });

  test('cache miss for different content', () => {
    clearMarkdownCache();
    renderMarkdown('# First');
    expect(markdownCacheSize()).toBe(1);
    renderMarkdown('# Second');
    expect(markdownCacheSize()).toBe(2);
  });

  test('plain prose bypasses cache (fast-path)', () => {
    clearMarkdownCache();
    const plain = 'Hello there, this is just plain text.';
    renderMarkdown(plain);
    // No MD markers → fast-path → nothing cached
    expect(markdownCacheSize()).toBe(0);
  });

  test('10-turn repeat achieves 100% cache hit (≥90% required)', () => {
    clearMarkdownCache();
    const md = '## Section\n\nSome **content** with `code`.';
    // First call: cache miss
    renderMarkdown(md);
    let hits = 0;
    for (let i = 0; i < 10; i++) {
      const sizeBefore = markdownCacheSize();
      renderMarkdown(md);
      const sizeAfter = markdownCacheSize();
      if (sizeAfter === sizeBefore) hits++;
    }
    expect(hits / 10).toBeGreaterThanOrEqual(0.9);
  });

  test('partial/malformed markdown does not throw', () => {
    expect(() => renderMarkdown('```\nunclosed fenced block')).not.toThrow();
  });

  test('ANSI stripped before cache key computation', () => {
    clearMarkdownCache();
    const clean = '# Hello';
    const withAnsi = '\x1b[1m# Hello\x1b[0m';
    const r1 = renderMarkdown(clean);
    const r2 = renderMarkdown(withAnsi);
    // Both should produce the same output (ANSI stripped before parsing)
    expect(r1).toBe(r2);
  });
});

// ── SPEC-843: MAX_STATIC_BLOCKS eviction ─────────────────────────────────────
describe('SPEC-843: MAX_STATIC_BLOCKS LRU eviction', () => {
  test('MAX_STATIC_BLOCKS constant is 500', () => {
    expect(MAX_STATIC_BLOCKS).toBe(500);
  });

  test('600 blocks → only last 500 retained', () => {
    let blocks: Array<{ id: string; text: string }> = [];
    for (let i = 0; i < 600; i++) {
      blocks = addStaticBlock(blocks, { id: `block-${i}`, text: `text ${i}` });
    }
    expect(blocks.length).toBe(500);
    // Oldest 100 blocks should be evicted (block-0 through block-99)
    expect(blocks[0]?.id).toBe('block-100');
    expect(blocks[blocks.length - 1]?.id).toBe('block-599');
  });

  test('exactly 500 blocks → no eviction', () => {
    let blocks: Array<{ id: string; text: string }> = [];
    for (let i = 0; i < 500; i++) {
      blocks = addStaticBlock(blocks, { id: `b-${i}`, text: `t` });
    }
    expect(blocks.length).toBe(500);
    expect(blocks[0]?.id).toBe('b-0');
  });

  test('499 blocks → no eviction', () => {
    let blocks: Array<{ id: string; text: string }> = [];
    for (let i = 0; i < 499; i++) {
      blocks = addStaticBlock(blocks, { id: `b-${i}`, text: `t` });
    }
    expect(blocks.length).toBe(499);
  });
});

// ── SPEC-843: Spinner frame rotation ─────────────────────────────────────────
describe('SPEC-843: Spinner frames per platform', () => {
  test('SPINNER_FRAMES has 6 frames', () => {
    expect(SPINNER_FRAMES.length).toBe(6);
  });

  test('SPINNER_FRAMES_PINGPONG is longer than base frames', () => {
    // ping-pong: [...frames, ...frames.slice(1,-1).reverse()] = 6 + 4 = 10
    expect(SPINNER_FRAMES_PINGPONG.length).toBeGreaterThan(SPINNER_FRAMES.length);
  });

  test('ping-pong sequence contains all original frames', () => {
    for (const frame of SPINNER_FRAMES) {
      expect(SPINNER_FRAMES_PINGPONG).toContain(frame);
    }
  });

  test('FRAME_INTERVAL_MS is 80', () => {
    expect(FRAME_INTERVAL_MS).toBe(80);
  });

  test('STALL_THRESHOLD_MS is 3000', () => {
    expect(STALL_THRESHOLD_MS).toBe(3000);
  });

  test('REDUCED_MOTION_CYCLE_MS is 2000', () => {
    expect(REDUCED_MOTION_CYCLE_MS).toBe(2000);
  });

  test('darwin frames use ✽ not * at position 5', () => {
    if (process.platform === 'darwin' && process.env['TERM_PROGRAM'] !== 'ghostty') {
      expect(SPINNER_FRAMES[5]).toBe('✽');
      expect(SPINNER_FRAMES[2]).toBe('✳');
    } else if (process.platform !== 'darwin' && process.env['TERM_PROGRAM'] !== 'ghostty') {
      // Linux/Windows: pos 2 = *, pos 5 = ✽
      expect(SPINNER_FRAMES[2]).toBe('*');
    }
  });
});

// ── SPEC-843: Stall color interpolation ──────────────────────────────────────
describe('SPEC-843: Stall color interpolation', () => {
  // Colors: from rgb(215,119,87) → rgb(171,43,63)

  test('t=0 (no stall) returns from-color', () => {
    expect(lerpColor(0)).toBe('rgb(215,119,87)');
  });

  test('t=1 (fully stalled) returns to-color', () => {
    expect(lerpColor(1)).toBe('rgb(171,43,63)');
  });

  test('t=0.5 returns midpoint color', () => {
    // r: 215 + (171-215)*0.5 = 215 - 22 = 193
    // g: 119 + (43-119)*0.5  = 119 - 38 = 81
    // b: 87  + (63-87)*0.5   = 87  - 12 = 75
    expect(lerpColor(0.5)).toBe('rgb(193,81,75)');
  });

  test('t=1/3 (1s out of 3s threshold)', () => {
    const t = 1 / 3;
    const r = Math.round(215 + (171 - 215) * t);
    const g = Math.round(119 + (43 - 119) * t);
    const b = Math.round(87 + (63 - 87) * t);
    expect(lerpColor(t)).toBe(`rgb(${r},${g},${b})`);
  });

  test('t=2/3 (2s out of 3s threshold)', () => {
    const t = 2 / 3;
    const r = Math.round(215 + (171 - 215) * t);
    const g = Math.round(119 + (43 - 119) * t);
    const b = Math.round(87 + (63 - 87) * t);
    expect(lerpColor(t)).toBe(`rgb(${r},${g},${b})`);
  });

  test('t>1 clamped to to-color', () => {
    expect(lerpColor(5)).toBe('rgb(171,43,63)');
    expect(lerpColor(100)).toBe('rgb(171,43,63)');
  });

  test('t<0 clamped to from-color', () => {
    expect(lerpColor(-1)).toBe('rgb(215,119,87)');
  });
});

// ── SPEC-843: Tool-use glyph per platform ─────────────────────────────────────
describe('SPEC-843: Tool-use glyph per platform', () => {
  test('TOOL_USE_GLYPH is ⏺ on darwin or ● on other platforms', () => {
    if (process.platform === 'darwin') {
      expect(TOOL_USE_GLYPH).toBe('⏺');
    } else {
      expect(TOOL_USE_GLYPH).toBe('●');
    }
  });

  test('BULLET_GLYPH is always ●', () => {
    expect(BULLET_GLYPH).toBe('●');
  });
});

// ── SPEC-843: SpinnerWithVerb renders ─────────────────────────────────────────
describe('SPEC-843: SpinnerWithVerb component', () => {
  test('renders without throw in normal mode', () => {
    const { lastFrame } = render(
      wrapApp(React.createElement(SpinnerWithVerb, { verb: 'Thinking', stalled: false, stallSecs: 0 })),
    );
    expect(lastFrame()).toBeDefined();
  });

  test('renders with verb override', () => {
    const { lastFrame } = render(
      wrapApp(React.createElement(SpinnerWithVerb, { verb: 'Computing' })),
    );
    expect(lastFrame()).toContain('Computing');
  });

  test('renders in reduced-motion mode', () => {
    const { lastFrame } = render(
      wrapApp(
        React.createElement(SpinnerWithVerb, { verb: 'Processing' }),
        { reducedMotion: true },
      ),
    );
    // reduced-motion renders ● (BULLET_GLYPH)
    expect(lastFrame()).toContain('●');
  });
});

// ── SPEC-843: Markdown component renders ─────────────────────────────────────
describe('SPEC-843: Markdown component renders', () => {
  test('renders plain text without throw', () => {
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider,
        { name: 'dark' },
        React.createElement(Markdown, { text: 'Hello world', raw: false }),
      ),
    );
    expect(lastFrame()).toContain('Hello world');
  });

  test('renders in raw mode (strips ANSI)', () => {
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider,
        { name: 'dark' },
        React.createElement(Markdown, { text: 'hello \x1b[32mworld\x1b[0m', raw: true }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello');
    expect(frame).toContain('world');
    expect(frame).not.toContain('\x1b');
  });

  test('partial fenced code block does not throw', () => {
    expect(() => {
      const { unmount } = render(
        React.createElement(
          ThemeProvider,
          { name: 'dark' },
          React.createElement(Markdown, { text: '```\nunclosed fenced block', raw: false }),
        ),
      );
      unmount();
    }).not.toThrow();
  });
});

// ── SPEC-843: ToolUseMessage renders ─────────────────────────────────────────
describe('SPEC-843: ToolUseMessage component', () => {
  test('renders tool name', () => {
    const { lastFrame } = render(
      wrapApp(
        React.createElement(ToolUseMessage, {
          toolName: 'bash',
          input: { command: 'ls' },
          state: 'done',
          stallSecs: 0,
        }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('bash');
  });

  test('renders tool glyph', () => {
    const { lastFrame } = render(
      wrapApp(
        React.createElement(ToolUseMessage, {
          toolName: 'readFile',
          input: { path: '/tmp/test.txt' },
          state: 'done',
        }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(TOOL_USE_GLYPH);
  });

  test('custom arg renderer overrides default', () => {
    registerToolRenderer('myTool', (_input: unknown) => 'custom-arg-display');

    const { lastFrame } = render(
      wrapApp(
        React.createElement(ToolUseMessage, {
          toolName: 'myTool',
          input: { anything: true },
          state: 'done',
        }),
      ),
    );
    expect(lastFrame()).toContain('custom-arg-display');
  });
});
