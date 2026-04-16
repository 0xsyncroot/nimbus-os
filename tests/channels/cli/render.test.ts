import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRenderer } from '../../../src/channels/cli/render.ts';
import type { RendererOutput } from '../../../src/channels/cli/render.ts';
import type { LoopOutput } from '../../../src/core/turn.ts';
import type { CanonicalChunk } from '../../../src/ir/types.ts';

// Force ANSI output in all tests (same pattern as markdownRender.test.ts).
const origForceColor = process.env['FORCE_COLOR'];
const origNoColor = process.env['NO_COLOR'];

// ── test helpers ──────────────────────────────────────────────────────────────

interface CaptureStream extends RendererOutput {
  captured: string;
}

function makeStream(opts: { isTTY?: boolean } = {}): CaptureStream {
  const stream: CaptureStream = {
    captured: '',
    isTTY: opts.isTTY ?? false,
    write(s: string): void {
      this.captured += s;
    },
  };
  return stream;
}

// Small helpers that produce correctly-typed LoopOutput values.

function textDelta(text: string): LoopOutput {
  const chunk: CanonicalChunk = {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text', text },
  };
  return { kind: 'chunk', chunk };
}

function messageStop(): LoopOutput {
  const chunk: CanonicalChunk = { type: 'message_stop', finishReason: 'end_turn' };
  return { kind: 'chunk', chunk };
}

// ── SPEC-801: render.ts v0.2.8 ────────────────────────────────────────────────

describe('SPEC-801: render v0.2.8 — streaming + plan suppression', () => {
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
  // ── Fix 1 — streaming ───────────────────────────────────────────────────────

  test('text delta streams to stdout immediately', () => {
    const out = makeStream();
    const renderer = createRenderer(out);
    renderer.handle(textDelta('Hello'));
    // Text must be present BEFORE message_stop / flush
    expect(out.captured).toBe('Hello');
  });

  test('markdown buffer re-renders with ANSI bold on message_stop (TTY)', () => {
    const out = makeStream({ isTTY: true });
    const renderer = createRenderer(out);
    renderer.handle(textDelta('**bold**'));
    renderer.handle(messageStop());
    // Re-render must have produced ANSI bold
    expect(out.captured).toContain('\x1b[1m');
  });

  test('markdown buffer emits cursor-up escape when newlines were streamed (TTY)', () => {
    const out = makeStream({ isTTY: true });
    const renderer = createRenderer(out);
    // Include a newline so streamedLineCount becomes 1
    renderer.handle(textDelta('**bold**\n'));
    renderer.handle(messageStop());
    // Cursor-up control sequence ESC[NF must appear
    expect(out.captured).toContain('\x1b[');
    expect(out.captured).toContain('F');
  });

  test('plain text: no re-render escape sequence emitted', () => {
    const out = makeStream({ isTTY: true });
    const renderer = createRenderer(out);
    renderer.handle(textDelta('hello world'));
    renderer.handle(messageStop());
    // Plain text → no ANSI at all, just text + trailing newline
    expect(out.captured).toBe('hello world\n');
  });

  test('non-TTY: markdown NOT re-rendered even when markdown syntax present', () => {
    const out = makeStream({ isTTY: false });
    const renderer = createRenderer(out);
    renderer.handle(textDelta('**bold**'));
    renderer.handle(messageStop());
    // Non-TTY: no cursor-up, no ANSI bold — just the raw text + trailing newline
    expect(out.captured).toBe('**bold**\n');
    expect(out.captured).not.toContain('\x1b[1m');
  });

  // ── Fix 2 — [PLAN] never written to stdout ──────────────────────────────────

  test('[PLAN] never written to stdout — plan_announce', () => {
    const out = makeStream();
    const renderer = createRenderer(out);
    renderer.handle({ kind: 'plan_announce', reason: 'Người dùng sẽ nhận được kết quả', heuristic: 'multi_step' });
    expect(out.captured).not.toContain('[PLAN]');
    expect(out.captured).not.toContain('Người dùng');
    expect(out.captured).toBe('');
  });

  test('[PLAN] never written to stdout — spec_announce', () => {
    const out = makeStream();
    const renderer = createRenderer(out);
    renderer.handle({ kind: 'spec_announce', summary: 'find travel information' });
    expect(out.captured).not.toContain('[PLAN]');
    expect(out.captured).not.toContain('find travel');
    expect(out.captured).toBe('');
  });

  // ── Regression — existing events still work ─────────────────────────────────

  test('tool_start emits tool prefix line', () => {
    const out = makeStream();
    const renderer = createRenderer(out);
    renderer.handle({ kind: 'tool_start', toolUseId: 'tid_1', name: 'bash' });
    expect(out.captured).toContain('bash');
  });

  test('tool_end emits ok prefix with duration', () => {
    const out = makeStream();
    const renderer = createRenderer(out);
    renderer.handle({ kind: 'tool_end', toolUseId: 'tid_1', ok: true, ms: 42 });
    expect(out.captured).toContain('42ms');
  });

  test('turn_end with cancelled outcome emits warn text', () => {
    const out = makeStream();
    const renderer = createRenderer(out);
    renderer.handle({
      kind: 'turn_end',
      metric: { turnId: 't1', sessionId: 's1', outcome: 'cancelled', ms: 100, iterations: 1 },
    });
    expect(out.captured).toContain('cancelled');
  });

  test('turn_end with error outcome emits error code', () => {
    const out = makeStream();
    const renderer = createRenderer(out);
    renderer.handle({
      kind: 'turn_end',
      metric: {
        turnId: 't1',
        sessionId: 's1',
        outcome: 'error',
        ms: 100,
        iterations: 1,
        errorCode: 'P_NETWORK',
      },
    });
    expect(out.captured).toContain('P_NETWORK');
  });

  // ── flush utility ───────────────────────────────────────────────────────────

  test('flush() appends trailing newline for buffered plain text', () => {
    const out = makeStream();
    const renderer = createRenderer(out);
    renderer.handle(textDelta('partial'));
    renderer.flush();
    expect(out.captured).toBe('partial\n');
  });

  test('flush() is no-op when buffer is empty', () => {
    const out = makeStream();
    const renderer = createRenderer(out);
    renderer.flush();
    expect(out.captured).toBe('');
  });
});
