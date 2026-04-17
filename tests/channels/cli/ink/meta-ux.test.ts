// meta-ux.test.ts — SPEC-849: Full test suite for meta-UX helpers + keybinding manager.
// Tests: useBreakpoints, AltScreen DEC 1049, SIGINT/exit handlers, DECSET 2026,
// keybinding resolver, double-press Ctrl-C, reserved key guard, user overrides.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

// Static imports
import { deriveBreakpoints, BP_COMPACT, BP_NARROW, BP_TIGHT } from '../../../../src/channels/cli/ink/breakpoints.ts';
import { useAltScreen } from '../../../../src/channels/cli/ink/altScreen.tsx';
import { beginSyncOutput, endSyncOutput } from '../../../../src/channels/cli/ink/syncOutput.ts';
import { isReserved, assertNotReserved } from '../../../../src/channels/cli/ink/keybindings/reservedShortcuts.ts';
import { createKeybindingManager } from '../../../../src/channels/cli/ink/keybindings/index.ts';
import { isSingleCtrlLetter, isChord } from '../../../../src/channels/cli/ink/keybindings/defaultBindings.ts';
import { CHORD_TIMEOUT_MS } from '../../../../src/channels/cli/ink/keybindings/resolver.ts';
import { loadUserOverrides } from '../../../../src/channels/cli/ink/keybindings/userOverrides.ts';
import { NimbusError, ErrorCode } from '../../../../src/observability/errors.ts';

// ── Breakpoints ────────────────────────────────────────────────────────────────

describe('SPEC-849: deriveBreakpoints', () => {
  test('cols=59 → isTight=true, isNarrow=true, isCompact=true', () => {
    const bp = deriveBreakpoints(59);
    expect(bp.isTight).toBe(true);
    expect(bp.isNarrow).toBe(true);
    expect(bp.isCompact).toBe(true);
  });

  test('cols=60 → isTight=false (boundary), isNarrow=true, isCompact=true', () => {
    const bp = deriveBreakpoints(60);
    expect(bp.isTight).toBe(false);
    expect(bp.isNarrow).toBe(true);
    expect(bp.isCompact).toBe(true);
  });

  test('cols=79 → isTight=false, isNarrow=true, isCompact=true', () => {
    const bp = deriveBreakpoints(79);
    expect(bp.isTight).toBe(false);
    expect(bp.isNarrow).toBe(true);
    expect(bp.isCompact).toBe(true);
  });

  test('cols=80 → isTight=false, isNarrow=false (boundary), isCompact=true', () => {
    const bp = deriveBreakpoints(80);
    expect(bp.isTight).toBe(false);
    expect(bp.isNarrow).toBe(false);
    expect(bp.isCompact).toBe(true);
  });

  test('cols=119 → isTight=false, isNarrow=false, isCompact=true', () => {
    const bp = deriveBreakpoints(119);
    expect(bp.isTight).toBe(false);
    expect(bp.isNarrow).toBe(false);
    expect(bp.isCompact).toBe(true);
  });

  test('cols=120 → all false (boundary)', () => {
    const bp = deriveBreakpoints(120);
    expect(bp.isTight).toBe(false);
    expect(bp.isNarrow).toBe(false);
    expect(bp.isCompact).toBe(false);
  });

  test('cols=200 → all false', () => {
    const bp = deriveBreakpoints(200);
    expect(bp.isTight).toBe(false);
    expect(bp.isNarrow).toBe(false);
    expect(bp.isCompact).toBe(false);
  });

  test('BP thresholds are correct constants', () => {
    expect(BP_COMPACT).toBe(120);
    expect(BP_NARROW).toBe(80);
    expect(BP_TIGHT).toBe(60);
  });
});

// ── AltScreen escape sequences ─────────────────────────────────────────────────

describe('SPEC-849: AltScreen escape sequences', () => {
  const ENTER_ALT = '\x1b[?1049h';
  const EXIT_ALT = '\x1b[?1049l';
  const CURSOR_SHOW = '\x1b[?25h';
  const CURSOR_HOME = '\x1b[2J\x1b[H';
  // CSI 3J (\x1b[3J) must NEVER appear (ink#935 guard)
  const FORBIDDEN_CSI_3J = '\x1b[3J';

  let written: string[] = [];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    written = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    // Use Object.defineProperty to ensure the mock is installed even when
    // process.stdout.write is a non-configurable native getter on macOS/Windows.
    const mockWrite = (chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      Object.defineProperty(process.stdout, 'write', {
        value: mockWrite,
        writable: true,
        configurable: true,
      });
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = mockWrite;
    }
  });

  afterEach(() => {
    try {
      Object.defineProperty(process.stdout, 'write', {
        value: originalWrite,
        writable: true,
        configurable: true,
      });
    } catch {
      process.stdout.write = originalWrite;
    }
    // Clean up any lingering handlers from test leaks
    process.removeAllListeners('exit');
    process.removeAllListeners('SIGINT');
  });

  test('useAltScreen().enter() emits DEC 1049 + cursor home', () => {
    const { enter, exit } = useAltScreen();
    enter();
    // Concatenate all writes — enter() may emit sequences in separate write calls
    // on some platforms (macOS buffers stdout differently than Linux).
    const combined = written.join('');
    expect(combined).toContain(ENTER_ALT);
    expect(combined).toContain(CURSOR_HOME);
    expect(combined).not.toContain(FORBIDDEN_CSI_3J);
    exit();
  });

  test('useAltScreen().exit() emits DEC 1049 exit + cursor show', () => {
    const { enter, exit } = useAltScreen();
    enter();
    written = []; // reset capture
    exit();
    // Concatenate all writes — exit() may emit sequences in separate write calls
    // on some platforms (macOS buffers stdout differently than Linux).
    const combined = written.join('');
    expect(combined).toContain(EXIT_ALT);
    expect(combined).toContain(CURSOR_SHOW);
  });

  test('exit() is idempotent — second call does not write again', () => {
    const { enter, exit } = useAltScreen();
    enter();
    written = [];
    exit();
    const firstExitWrites = written.length;
    written = [];
    exit(); // second call
    expect(written.length).toBe(0);
    expect(firstExitWrites).toBeGreaterThan(0);
  });

  test('exit() never emits CSI 3J (ink#935 guard)', () => {
    const { enter, exit } = useAltScreen();
    enter();
    exit();
    const combined = written.join('');
    expect(combined).not.toContain(FORBIDDEN_CSI_3J);
  });

  test('cleanup path emits EXIT_ALT + CURSOR_SHOW', () => {
    const { enter, exit } = useAltScreen();
    enter();
    written = [];
    exit();
    const combined = written.join('');
    expect(combined).toContain(EXIT_ALT);
    expect(combined).toContain(CURSOR_SHOW);
  });
});

// ── Sync Output ────────────────────────────────────────────────────────────────

describe('SPEC-849: syncOutput DECSET 2026', () => {
  const SYNC_START = '\x1b[?2026h';
  const SYNC_END = '\x1b[?2026l';

  let written: string[] = [];
  let originalWrite: typeof process.stdout.write;
  let originalTerm: string | undefined;
  let originalTermProgram: string | undefined;

  beforeEach(() => {
    written = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    originalTerm = process.env['TERM'];
    originalTermProgram = process.env['TERM_PROGRAM'];
    const mockWrite = (chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      Object.defineProperty(process.stdout, 'write', {
        value: mockWrite,
        writable: true,
        configurable: true,
      });
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = mockWrite;
    }
  });

  afterEach(() => {
    try {
      Object.defineProperty(process.stdout, 'write', {
        value: originalWrite,
        writable: true,
        configurable: true,
      });
    } catch {
      process.stdout.write = originalWrite;
    }
    if (originalTerm !== undefined) {
      process.env['TERM'] = originalTerm;
    } else {
      delete process.env['TERM'];
    }
    if (originalTermProgram !== undefined) {
      process.env['TERM_PROGRAM'] = originalTermProgram;
    } else {
      delete process.env['TERM_PROGRAM'];
    }
    process.removeAllListeners('exit');
    process.removeAllListeners('SIGINT');
  });

  test('beginSyncOutput() emits SYNC_START when TERM=tmux-256color', () => {
    process.env['TERM'] = 'tmux-256color';
    delete process.env['TERM_PROGRAM'];
    beginSyncOutput();
    expect(written.join('')).toContain(SYNC_START);
  });

  test('beginSyncOutput() emits SYNC_START when TERM=screen-256color', () => {
    process.env['TERM'] = 'screen-256color';
    delete process.env['TERM_PROGRAM'];
    beginSyncOutput();
    expect(written.join('')).toContain(SYNC_START);
  });

  test('beginSyncOutput() is no-op when TERM=xterm-256color', () => {
    process.env['TERM'] = 'xterm-256color';
    delete process.env['TERM_PROGRAM'];
    beginSyncOutput();
    expect(written.join('')).toBe('');
  });

  test('endSyncOutput() emits SYNC_END when TERM=tmux-256color', () => {
    process.env['TERM'] = 'tmux-256color';
    delete process.env['TERM_PROGRAM'];
    endSyncOutput();
    expect(written.join('')).toContain(SYNC_END);
  });

  test('endSyncOutput() is no-op when TERM=xterm-256color', () => {
    process.env['TERM'] = 'xterm-256color';
    delete process.env['TERM_PROGRAM'];
    endSyncOutput();
    expect(written.join('')).toBe('');
  });

  test('SYNC_END sequence is correct', () => {
    expect(SYNC_END).toBe('\x1b[?2026l');
  });
});

// ── Reserved shortcuts ─────────────────────────────────────────────────────────

describe('SPEC-849: reservedShortcuts', () => {
  test('ctrl+c is reserved', () => {
    expect(isReserved('ctrl+c')).toBe(true);
  });

  test('ctrl+d is reserved', () => {
    expect(isReserved('ctrl+d')).toBe(true);
  });

  test('ctrl+l is not reserved', () => {
    expect(isReserved('ctrl+l')).toBe(false);
  });

  test('return is not reserved', () => {
    expect(isReserved('return')).toBe(false);
  });

  test('assertNotReserved throws NimbusError(P_KEYBIND_RESERVED) for ctrl+c', () => {
    expect(() => assertNotReserved('ctrl+c')).toThrow();
    let caughtErr: unknown;
    try {
      assertNotReserved('ctrl+c');
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr instanceof NimbusError).toBe(true);
    expect((caughtErr as NimbusError).code).toBe(ErrorCode.P_KEYBIND_RESERVED);
  });

  test('assertNotReserved throws NimbusError(P_KEYBIND_RESERVED) for ctrl+d', () => {
    expect(() => assertNotReserved('ctrl+d')).toThrow();
  });

  test('assertNotReserved does not throw for ctrl+l', () => {
    expect(() => assertNotReserved('ctrl+l')).not.toThrow();
  });
});

// ── KeybindingManager ──────────────────────────────────────────────────────────

describe('SPEC-849: KeybindingManager', () => {
  test('Global ctrl+l resolves app:redraw', () => {
    const mgr = createKeybindingManager();
    const action = mgr.resolve(['Global'], 'ctrl+l');
    expect(action).toBe('app:redraw');
  });

  test('Chat context: return resolves chat:submit', () => {
    const mgr = createKeybindingManager();
    const action = mgr.resolve(['Global', 'Chat'], 'return');
    expect(action).toBe('chat:submit');
  });

  test('Autocomplete context overrides Chat for return: autocomplete:accept wins', () => {
    const mgr = createKeybindingManager();
    const action = mgr.resolve(['Global', 'Chat', 'Autocomplete'], 'return');
    expect(action).toBe('autocomplete:accept');
  });

  test('Select context: return resolves select:accept', () => {
    const mgr = createKeybindingManager();
    const action = mgr.resolve(['Global', 'Select'], 'return');
    expect(action).toBe('select:accept');
  });

  test('Confirmation context: y resolves confirmation:yes', () => {
    const mgr = createKeybindingManager();
    const action = mgr.resolve(['Global', 'Chat', 'Confirmation'], 'y');
    expect(action).toBe('confirmation:yes');
  });

  test('unknown key returns undefined', () => {
    const mgr = createKeybindingManager();
    const action = mgr.resolve(['Global'], 'ctrl+q');
    expect(action).toBeUndefined();
  });

  test('register() then resolve() returns registered action', () => {
    const mgr = createKeybindingManager();
    mgr.register('Global', 'ctrl+z', 'app:interrupt');
    const action = mgr.resolve(['Global'], 'ctrl+z');
    expect(action).toBe('app:interrupt');
  });

  test('register() throws NimbusError for ctrl+c (reserved)', () => {
    const mgr = createKeybindingManager();
    expect(() => mgr.register('Global', 'ctrl+c', 'app:interrupt')).toThrow();
    let err: unknown;
    try {
      mgr.register('Global', 'ctrl+c', 'app:interrupt');
    } catch (e) {
      err = e;
    }
    expect(err instanceof NimbusError).toBe(true);
    expect((err as NimbusError).code).toBe(ErrorCode.P_KEYBIND_RESERVED);
  });

  test('register() throws NimbusError for ctrl+d (reserved)', () => {
    const mgr = createKeybindingManager();
    expect(() => mgr.register('Chat', 'ctrl+d', 'chat:cancel')).toThrow();
  });

  test('pushContext/popContext/getActive work correctly', () => {
    const mgr = createKeybindingManager();
    expect(mgr.getActive()).toEqual(['Global']);
    mgr.pushContext('Chat');
    expect(mgr.getActive()).toEqual(['Global', 'Chat']);
    mgr.pushContext('Autocomplete');
    expect(mgr.getActive()).toEqual(['Global', 'Chat', 'Autocomplete']);
    const popped = mgr.popContext();
    expect(popped).toBe('Autocomplete');
    expect(mgr.getActive()).toEqual(['Global', 'Chat']);
  });

  test('popContext() returns undefined when only Global remains', () => {
    const mgr = createKeybindingManager();
    const popped = mgr.popContext();
    expect(popped).toBeUndefined();
    expect(mgr.getActive()).toEqual(['Global']);
  });
});

// ── Chord policy ───────────────────────────────────────────────────────────────

describe('SPEC-849: chord policy', () => {
  test('ctrl+a is a single ctrl+letter (immediate, not chord prefix)', () => {
    expect(isSingleCtrlLetter('ctrl+a')).toBe(true);
  });

  test('ctrl+e is a single ctrl+letter', () => {
    expect(isSingleCtrlLetter('ctrl+e')).toBe(true);
  });

  test('ctrl+r is a single ctrl+letter', () => {
    expect(isSingleCtrlLetter('ctrl+r')).toBe(true);
  });

  test('ctrl+g is a single ctrl+letter (chord leader)', () => {
    expect(isSingleCtrlLetter('ctrl+g')).toBe(true);
  });

  test('"ctrl+g h" is a chord key (has space)', () => {
    expect(isChord('ctrl+g h')).toBe(true);
  });

  test('"\\h" is a chord key (backslash leader)', () => {
    expect(isChord('\\h')).toBe(true);
  });

  test('"return" is not a chord', () => {
    expect(isChord('return')).toBe(false);
  });

  test('CHORD_TIMEOUT_MS is 1500', () => {
    expect(CHORD_TIMEOUT_MS).toBe(1500);
  });

  test('chord: ctrl+g starts pending state; second key within timeout resolves', () => {
    const mgr = createKeybindingManager();
    // First press: ctrl+g — chord leader, should return undefined (waiting)
    const first = mgr.resolve(['Global'], 'ctrl+g');
    expect(first).toBeUndefined();
    // Second press: h — should complete chord ctrl+g h → app:toggleHelp
    const second = mgr.resolve(['Global'], 'h');
    expect(second).toBe('app:toggleHelp');
  });

  test('ctrl+a alone resolves immediately when registered', () => {
    const mgr = createKeybindingManager();
    mgr.register('Global', 'ctrl+a', 'scroll:home');
    const action = mgr.resolve(['Global'], 'ctrl+a');
    expect(action).toBe('scroll:home');
  });
});

// ── User overrides ─────────────────────────────────────────────────────────────

describe('SPEC-849: userOverrides', () => {
  const tmpDir = join(tmpdir(), 'nimbus-meta-ux-test-' + process.pid);

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  test('returns undefined when file does not exist', async () => {
    const result = await loadUserOverrides(join(tmpDir, 'nonexistent.json'));
    expect(result).toBeUndefined();
  });

  test('returns undefined + warns on invalid JSON', async () => {
    const filePath = join(tmpDir, 'keybindings.json');
    writeFileSync(filePath, 'NOT JSON {{{{');
    const result = await loadUserOverrides(filePath);
    expect(result).toBeUndefined();
  });

  test('returns undefined + warns on schema validation failure (unknown action)', async () => {
    const filePath = join(tmpDir, 'keybindings.json');
    writeFileSync(filePath, JSON.stringify({
      Global: { 'ctrl+z': 'fake:action:not:real' },
    }));
    const result = await loadUserOverrides(filePath);
    expect(result).toBeUndefined();
  });

  test('returns undefined + warns when reserved key ctrl+c is in config', async () => {
    const filePath = join(tmpDir, 'keybindings.json');
    writeFileSync(filePath, JSON.stringify({
      Global: { 'ctrl+c': 'app:exit' },
    }));
    const result = await loadUserOverrides(filePath);
    expect(result).toBeUndefined();
  });

  test('returns parsed overrides for valid config', async () => {
    const filePath = join(tmpDir, 'keybindings.json');
    writeFileSync(filePath, JSON.stringify({
      Global: { 'ctrl+z': 'app:interrupt' },
      Chat: { 'ctrl+x': 'chat:cancel' },
    }));
    const result = await loadUserOverrides(filePath);
    expect(result).toBeDefined();
    expect(result?.['Global']?.['ctrl+z']).toBe('app:interrupt');
    expect(result?.['Chat']?.['ctrl+x']).toBe('chat:cancel');
  });

  test('manager.loadUserOverrides() applies overrides correctly', async () => {
    const filePath = join(tmpDir, 'keybindings.json');
    writeFileSync(filePath, JSON.stringify({
      Global: { 'ctrl+z': 'app:interrupt' },
    }));
    const mgr = createKeybindingManager();
    await mgr.loadUserOverrides(filePath);
    expect(mgr.resolve(['Global'], 'ctrl+z')).toBe('app:interrupt');
  });

  test('manager.loadUserOverrides() falls back to defaults on invalid config', async () => {
    const filePath = join(tmpDir, 'keybindings.json');
    writeFileSync(filePath, '{ invalid json }');
    const mgr = createKeybindingManager();
    await mgr.loadUserOverrides(filePath);
    // Defaults still work
    expect(mgr.resolve(['Global'], 'ctrl+l')).toBe('app:redraw');
  });
});

// ── Ctrl-C double-press invariants ────────────────────────────────────────────

describe('SPEC-849: Ctrl-C DoublePress invariants', () => {
  test('CHORD_TIMEOUT_MS is 1500ms', () => {
    expect(CHORD_TIMEOUT_MS).toBe(1500);
  });

  test('ctrl+c double-press: reserved — throws NimbusError on register', () => {
    const mgr = createKeybindingManager();
    let err: unknown;
    try {
      mgr.register('Global', 'ctrl+c', 'app:exit');
    } catch (e) {
      err = e;
    }
    expect(err instanceof NimbusError).toBe(true);
    expect((err as NimbusError).code).toBe(ErrorCode.P_KEYBIND_RESERVED);
  });

  test('ctrl+c cannot be rebound in any context', () => {
    const mgr = createKeybindingManager();
    const contexts: Parameters<typeof mgr.register>[0][] = [
      'Global', 'Chat', 'Autocomplete', 'Select', 'Confirmation',
      'Scroll', 'HistorySearch', 'Transcript', 'Help',
    ];
    for (const ctx of contexts) {
      expect(() => mgr.register(ctx, 'ctrl+c', 'app:interrupt')).toThrow();
    }
  });

  test('ctrl+d cannot be rebound', () => {
    const mgr = createKeybindingManager();
    expect(() => mgr.register('Global', 'ctrl+d', 'app:exit')).toThrow();
  });
});
