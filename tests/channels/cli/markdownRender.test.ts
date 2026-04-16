import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { hasMarkdownSyntax, renderMarkdown } from '../../../src/channels/cli/markdownRender.ts';
import { stripAnsi } from '../../../src/channels/cli/colors.ts';

// Force color output so ANSI codes are present in all tests.
const origForceColor = process.env['FORCE_COLOR'];
const origNoColor = process.env['NO_COLOR'];

describe('SPEC-801: markdownRender', () => {
  beforeEach(() => {
    process.env['FORCE_COLOR'] = '1';
    delete process.env['NO_COLOR'];
  });

  afterEach(() => {
    if (origForceColor === undefined) delete process.env['FORCE_COLOR'];
    else process.env['FORCE_COLOR'] = origForceColor;
    if (origNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = origNoColor;
  });

  // ── hasMarkdownSyntax ───────────────────────────────────────────────────────

  describe('hasMarkdownSyntax', () => {
    test('detects bold markers', () => {
      expect(hasMarkdownSyntax('**bold**')).toBe(true);
    });
    test('detects heading marker', () => {
      expect(hasMarkdownSyntax('# Title')).toBe(true);
    });
    test('detects backtick', () => {
      expect(hasMarkdownSyntax('`code`')).toBe(true);
    });
    test('detects double newline', () => {
      expect(hasMarkdownSyntax('para one\n\npara two')).toBe(true);
    });
    test('returns false for plain text', () => {
      expect(hasMarkdownSyntax('hello world')).toBe(false);
    });
    test('returns false for empty string', () => {
      expect(hasMarkdownSyntax('')).toBe(false);
    });
  });

  // ── no-op fast path ─────────────────────────────────────────────────────────

  test('plain text (no markdown syntax) returns input unchanged', () => {
    const plain = 'Just a plain sentence with no markup.';
    expect(renderMarkdown(plain)).toBe(plain);
  });

  test('empty string returns empty string', () => {
    expect(renderMarkdown('')).toBe('');
  });

  // ── inline elements ─────────────────────────────────────────────────────────

  test('**bold** emits ANSI bold sequence', () => {
    const out = renderMarkdown('**bold**');
    expect(out).toContain('\x1b[1m');
    expect(stripAnsi(out).trim()).toContain('bold');
  });

  test('*italic* emits italic ANSI or _text_ fallback', () => {
    const out = renderMarkdown('*italic*');
    const plain = stripAnsi(out).trim();
    // Either ANSI italic (3m) is present or the fallback _..._
    const hasAnsiItalic = out.includes('\x1b[3m');
    const hasFallback = plain.includes('_italic_');
    expect(hasAnsiItalic || hasFallback).toBe(true);
    expect(plain).toContain('italic');
  });

  test('`codespan` emits info (cyan) ANSI', () => {
    const out = renderMarkdown('`hello`');
    expect(out).toContain('\x1b[36m');
    expect(stripAnsi(out).trim()).toContain('hello');
  });

  // ── headings ────────────────────────────────────────────────────────────────

  test('# heading emits bold + info ANSI codes', () => {
    const out = renderMarkdown('# Title');
    expect(out).toContain('\x1b[1m');
    expect(out).toContain('\x1b[36m');
    expect(stripAnsi(out)).toContain('# Title');
  });

  test('## heading also emits bold', () => {
    const out = renderMarkdown('## Sub');
    expect(out).toContain('\x1b[1m');
    expect(stripAnsi(out)).toContain('## Sub');
  });

  // ── lists ───────────────────────────────────────────────────────────────────

  test('unordered list uses bullet marker', () => {
    const out = renderMarkdown('- apple\n- banana\n');
    const plain = stripAnsi(out);
    expect(plain).toContain('• apple');
    expect(plain).toContain('• banana');
  });

  test('ordered list uses number markers', () => {
    const out = renderMarkdown('1. first\n2. second\n');
    const plain = stripAnsi(out);
    expect(plain).toContain('1. first');
    expect(plain).toContain('2. second');
  });

  test('nested list uses deeper indent than parent', () => {
    const out = renderMarkdown('- item\n  - nested\n');
    const plain = stripAnsi(out);
    const lines = plain.split('\n').filter(Boolean);
    const topLine = lines.find((l) => l.includes('item'));
    const nestedLine = lines.find((l) => l.includes('nested'));
    expect(nestedLine).toBeDefined();
    expect(topLine).toBeDefined();
    // nested must have more leading whitespace than the parent (depth=1 → 2-space indent)
    const topIndent = topLine!.length - topLine!.trimStart().length;
    const nestedIndent = nestedLine!.length - nestedLine!.trimStart().length;
    expect(nestedIndent).toBeGreaterThan(topIndent);
  });

  // ── code fence ──────────────────────────────────────────────────────────────

  test('code fence renders [lang] label and cyan body', () => {
    const out = renderMarkdown('```ts\nconst x = 1;\n```\n');
    expect(stripAnsi(out)).toContain('[ts]');
    expect(out).toContain('\x1b[36m'); // cyan body
    expect(stripAnsi(out)).toContain('const x = 1;');
  });

  test('code fence without lang omits label', () => {
    const out = renderMarkdown('```\nno lang\n```\n');
    expect(stripAnsi(out)).not.toContain('[');
    expect(stripAnsi(out)).toContain('no lang');
  });

  // ── blockquote ──────────────────────────────────────────────────────────────

  test('blockquote prefixes non-empty lines with │', () => {
    const out = renderMarkdown('> quote text\n');
    expect(stripAnsi(out)).toContain('│ ');
    expect(stripAnsi(out)).toContain('quote text');
  });

  // ── hr ──────────────────────────────────────────────────────────────────────

  test('hr renders a dim line of dashes', () => {
    const out = renderMarkdown('---\n');
    expect(out).toContain('\x1b[2m'); // dim
    expect(stripAnsi(out)).toContain('─');
  });

  // ── NO_COLOR strips all ANSI ────────────────────────────────────────────────

  test('NO_COLOR=1 renders markup stripped of ANSI but still structurally correct', () => {
    process.env['NO_COLOR'] = '1';
    delete process.env['FORCE_COLOR'];
    const out = renderMarkdown('**bold** and `code`');
    expect(out).not.toContain('\x1b[');
    expect(out).toContain('bold');
    expect(out).toContain('code');
  });

  // ── streaming simulation ─────────────────────────────────────────────────────

  test('streaming simulation: multiple deltas buffered then rendered on completion', () => {
    // Simulate what render.ts does: accumulate deltas, render at end.
    const deltas = ['**', 'str', 'eaming', '**', ' text'];
    const buf = deltas.join('');
    const out = renderMarkdown(buf);
    // Should have bold rendered
    expect(out).toContain('\x1b[1m');
    expect(stripAnsi(out).trim()).toContain('streaming');
    expect(stripAnsi(out).trim()).toContain('text');
  });

  test('streaming simulation: plain-text deltas pass through unchanged', () => {
    const deltas = ['hello ', 'world'];
    const buf = deltas.join('');
    const out = renderMarkdown(buf);
    expect(out).toBe(buf); // no markdown syntax → fast path
  });
});
