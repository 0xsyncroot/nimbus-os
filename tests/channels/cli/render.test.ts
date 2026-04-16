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

  // ── Regression — existing events still work (verbose mode preserves old format) ─

  test('tool_start in verbose mode emits tool name + toolUseId', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { verbose: true });
    renderer.handle({ kind: 'tool_start', toolUseId: 'tid_1', name: 'Bash' });
    expect(out.captured).toContain('Bash');
    expect(out.captured).toContain('tid_1');
  });

  test('tool_end in verbose mode emits duration ms', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { verbose: true });
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

// ── SPEC-826: friendly tool-event rendering ───────────────────────────────────

describe('SPEC-826: render — friendly tool event labels', () => {
  beforeEach(() => {
    delete process.env['NO_COLOR'];
    delete process.env['FORCE_COLOR'];
    delete process.env['NIMBUS_LANG'];
    delete process.env['LANG'];
  });

  afterEach(() => {
    delete process.env['NO_COLOR'];
    delete process.env['FORCE_COLOR'];
    delete process.env['NIMBUS_LANG'];
    delete process.env['LANG'];
  });

  // Snapshot 1: running state — VN (v0.3.4: "đang" is part of the label, not a
  // hardcoded prefix baked into the renderer)
  test('tool_start emits ⋯ đang ghi file {path} (vi)', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { locale: 'vi' });
    renderer.handle({
      kind: 'tool_start',
      toolUseId: 'call_abc123',
      name: 'Write',
      args: { path: 'bot.py' },
    });
    // Must contain the label, NOT toolUseId or raw tool name prefix
    expect(out.captured).toContain('đang ghi file bot.py');
    expect(out.captured).toContain('\u22EF'); // ⋯
    expect(out.captured).not.toContain('call_abc123');
    expect(out.captured).not.toContain('[TOOL]');
  });

  // Snapshot 2: running state — EN
  // v0.3.4 Bug A regression: EN path MUST NOT contain "đang".
  test('tool_start emits ⋯ writing {path} (en) — no "đang" leak', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { locale: 'en' });
    renderer.handle({
      kind: 'tool_start',
      toolUseId: 'call_abc123',
      name: 'Write',
      args: { path: 'bot.py' },
    });
    expect(out.captured).toContain('writing bot.py');
    expect(out.captured).not.toContain('đang');
    expect(out.captured).toContain('\u22EF');
    expect(out.captured).not.toContain('call_abc123');
  });

  // Bug A v0.3.4: user hit this exact symptom on LANG=C.UTF-8 server with Write tool
  test('tool_start EN path does NOT produce "đang writing" hybrid (Bug A repro)', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { locale: 'en' });
    renderer.handle({
      kind: 'tool_start',
      toolUseId: 'call_xyz',
      name: 'Write',
      args: { path: 'telegram.botToken' },
    });
    expect(out.captured).not.toContain('đang writing');
  });

  // Bug A — humanLabel missing + args missing → must still compose correctly
  test('tool_start without args still humanizes path-less tools (vi)', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { locale: 'vi' });
    renderer.handle({
      kind: 'tool_start',
      toolUseId: 'call_abc',
      name: 'MemoryTool',
    });
    expect(out.captured).toContain('đang ghi chú vào memory');
    expect(out.captured).not.toContain('đang đang');
  });

  // Snapshot 3: ok state — VN (humanLabel provided by loop)
  test('tool_end ok with humanLabel emits ✓ {label} (vi)', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { locale: 'vi' });
    renderer.handle({
      kind: 'tool_end',
      toolUseId: 'call_abc123',
      ok: true,
      ms: 38,
      humanLabel: 'ghi file bot.py',
    });
    expect(out.captured).toContain('\u2713'); // ✓
    expect(out.captured).toContain('ghi file bot.py');
    expect(out.captured).not.toContain('call_abc123');
    expect(out.captured).not.toContain('38ms');
  });

  // Snapshot 4: error state — VN
  test('tool_end error emits ✗ {friendly error} (vi)', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { locale: 'vi' });
    renderer.handle({
      kind: 'tool_end',
      toolUseId: 'call_abc123',
      ok: false,
      ms: 10,
      errorCode: 'T_TIMEOUT',
    });
    expect(out.captured).toContain('\u2717'); // ✗
    expect(out.captured).not.toContain('T_TIMEOUT');
    expect(out.captured).not.toContain('call_abc123');
    expect(out.captured).not.toContain('10ms');
    // Should contain the VN friendly message
    expect(out.captured).toContain('Quá lâu');
  });

  // Snapshot 5: error state — EN
  test('tool_end error emits ✗ {friendly error} (en)', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { locale: 'en' });
    renderer.handle({
      kind: 'tool_end',
      toolUseId: 'call_xyz',
      ok: false,
      ms: 5,
      errorCode: 'P_NETWORK',
    });
    expect(out.captured).toContain('\u2717');
    expect(out.captured).toContain('retrying');
    expect(out.captured).not.toContain('P_NETWORK');
  });

  // Verbose mode preserves old format
  test('verbose mode: tool_start emits [TOOL] → name + toolUseId', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { verbose: true });
    renderer.handle({ kind: 'tool_start', toolUseId: 'call_xyz', name: 'Bash' });
    expect(out.captured).toContain('[TOOL]');
    expect(out.captured).toContain('Bash');
    expect(out.captured).toContain('call_xyz');
    expect(out.captured).not.toContain('\u22EF');
  });

  test('verbose mode: tool_end ok emits toolUseId + ms', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { verbose: true });
    renderer.handle({ kind: 'tool_end', toolUseId: 'call_xyz', ok: true, ms: 99 });
    expect(out.captured).toContain('call_xyz');
    expect(out.captured).toContain('99ms');
  });

  test('verbose mode: tool_end error emits toolUseId + ms', () => {
    const out = makeStream();
    const renderer = createRenderer(out, { verbose: true });
    renderer.handle({ kind: 'tool_end', toolUseId: 'call_xyz', ok: false, ms: 5, errorCode: 'T_CRASH' });
    expect(out.captured).toContain('call_xyz');
    expect(out.captured).toContain('5ms');
    // In verbose mode the raw prefixes are shown, not friendly messages
    expect(out.captured).toContain('[ERROR]');
  });
});
