// picker.pty.smoke.test.ts — SPEC-901 v0.3.14 real-PTY smoke test.
//
// Why this exists: unit tests using a mock Readable stream never exercise
// the real code path where `readline.emitKeypressEvents` installs its
// decoder on a TTY file descriptor, and where `setRawMode` actually talks
// to the kernel. After four consecutive TTY picker regressions shipped in
// v0.3.10 → v0.3.13, mock-stream tests proved insufficient — every one of
// those bugs passed its unit tests and still mis-fired on a real terminal.
//
// What this does: allocates a pseudo-terminal via libc (posix_openpt →
// grantpt → unlockpt → ptsname), spawns the Bun harness at
// `scripts/pty-smoke/picker-harness.ts` with its stdin/stdout bound to the
// PTY slave, then drives it from the master fd with real ANSI escape
// sequences. Asserts each result by parsing the `<<RESULT:...>>` marker.
//
// Runs on Linux only (skipped on Windows + non-Linux posix where
// /dev/ptmx / libc.so.6 may not be present). This is the minimum viable
// Gate-B harness; the expect-script variant is kept alongside for local
// triage and CI fallback.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dlopen, FFIType, suffix, type Library } from 'bun:ffi';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';

// Skip on unsupported platforms (Windows; older glibc without posix_openpt).
const isLinux = process.platform === 'linux';
const harnessPath = 'scripts/pty-smoke/picker-harness.ts';

// O_RDWR = 2, O_NOCTTY = 0o400 on Linux. Combining avoids the child
// hijacking our controlling tty if it ever called ioctl(TIOCSCTTY).
const O_RDWR = 2;
const O_NOCTTY = 0o400;

interface Libc {
  posix_openpt: (flags: number) => number;
  grantpt: (fd: number) => number;
  unlockpt: (fd: number) => number;
  ptsname: (fd: number) => string | null;
}

function loadLibc(): Libc | null {
  try {
    const libName = suffix === 'dylib' ? 'libc.dylib' : 'libc.so.6';
    const lib = dlopen(libName, {
      posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
      grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
      unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
      ptsname: { args: [FFIType.i32], returns: FFIType.cstring },
    }) as Library<{
      posix_openpt: { args: [FFIType.i32]; returns: FFIType.i32 };
      grantpt: { args: [FFIType.i32]; returns: FFIType.i32 };
      unlockpt: { args: [FFIType.i32]; returns: FFIType.i32 };
      ptsname: { args: [FFIType.i32]; returns: FFIType.cstring };
    }>;
    return {
      posix_openpt: (flags: number) => Number(lib.symbols.posix_openpt(flags)),
      grantpt: (fd: number) => Number(lib.symbols.grantpt(fd)),
      unlockpt: (fd: number) => Number(lib.symbols.unlockpt(fd)),
      ptsname: (fd: number) => {
        const v = lib.symbols.ptsname(fd);
        return v === null ? null : String(v);
      },
    };
  } catch {
    return null;
  }
}

interface Pty {
  masterFd: number;
  slavePath: string;
  close(): void;
}

function openPty(libc: Libc): Pty {
  const masterFd = libc.posix_openpt(O_RDWR | O_NOCTTY);
  if (masterFd < 0) throw new Error('posix_openpt failed');
  if (libc.grantpt(masterFd) !== 0) {
    closeSync(masterFd);
    throw new Error('grantpt failed');
  }
  if (libc.unlockpt(masterFd) !== 0) {
    closeSync(masterFd);
    throw new Error('unlockpt failed');
  }
  const slavePath = libc.ptsname(masterFd);
  if (slavePath === null || slavePath.length === 0) {
    closeSync(masterFd);
    throw new Error('ptsname returned null');
  }
  return {
    masterFd,
    slavePath,
    close(): void {
      try { closeSync(masterFd); } catch { /* ignore */ }
    },
  };
}

/** Read all bytes currently available on the master fd, up to `deadlineMs`
 *  elapsed since the caller started waiting. We read in 256B chunks with a
 *  tiny non-blocking polling loop; this is enough bandwidth for picker
 *  renders which are <1KB. */
async function readUntil(
  masterFd: number,
  predicate: (buf: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const started = Date.now();
  const chunk = Buffer.alloc(4096);
  let acc = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const n = readSync(masterFd, chunk, 0, chunk.length, null);
      if (n > 0) {
        acc += chunk.subarray(0, n).toString('utf8');
        if (predicate(acc)) return acc;
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      // EAGAIN means no data right now — yield and retry. EIO after child
      // exit on Linux is expected; we return what we have.
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      if (code === 'EIO') return acc;
      throw err;
    }
    // Successful read of 0 also means slave closed on some platforms.
    // Yield briefly either way.
    await new Promise((r) => setTimeout(r, 5));
  }
  return acc;
}

async function runScenario(
  libc: Libc,
  keys: string[],
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number | null }> {
  const pty = openPty(libc);
  // Open the slave side as a plain fd and inherit it into the child as
  // stdin/stdout/stderr. The child sees /dev/pts/N which is a real TTY.
  const slaveFd = openSync(pty.slavePath, O_RDWR);
  let child: Subprocess | null = null;
  try {
    child = spawn({
      cmd: ['bun', 'run', harnessPath, 'confirm'],
      stdin: slaveFd,
      stdout: slaveFd,
      stderr: slaveFd,
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'xterm-256color' },
    });
    // Close our handle on the slave; the child owns it now.
    try { closeSync(slaveFd); } catch { /* ignore */ }

    // Wait for the prompt to render before feeding keys.
    await readUntil(
      pty.masterFd,
      (s) => /Do it\?/.test(s),
      timeoutMs,
    );
    // Small delay to guarantee setRawMode(true) + keypress listener armed.
    await new Promise((r) => setTimeout(r, 150));

    for (const k of keys) {
      writeSync(pty.masterFd, k);
      // Tiny gap mirrors the user's typing; also exercises the chunk-split
      // code path that broke in v0.3.13.
      await new Promise((r) => setTimeout(r, 20));
    }

    // Collect until we see the result marker OR the child exits.
    const out = await readUntil(
      pty.masterFd,
      (s) => /<<RESULT:[a-z]+>>/.test(s),
      timeoutMs,
    );
    const exitCode = await child.exited;
    return { stdout: out, exitCode };
  } finally {
    try { child?.kill(); } catch { /* ignore */ }
    pty.close();
  }
}

function parseResult(stdout: string): string | null {
  const m = stdout.match(/<<RESULT:([a-z]+)>>/);
  return m ? m[1]! : null;
}

const describeIf = isLinux ? describe : describe.skip;

describeIf('SPEC-901 v0.3.14: picker PTY smoke (real pseudo-terminal)', () => {
  let libc: Libc | null = null;

  beforeAll(() => {
    libc = loadLibc();
  });

  afterAll(() => {
    // nothing global to release
  });

  test('Enter on default → allow', async () => {
    if (!libc) { expect(true).toBe(true); return; } // skip — libc not loadable
    const { stdout } = await runScenario(libc, ['\r'], 5000);
    expect(parseResult(stdout)).toBe('allow');
  }, 10_000);

  test('ArrowDown + Enter → deny', async () => {
    if (!libc) { expect(true).toBe(true); return; }
    const { stdout } = await runScenario(libc, ['\u001b[B', '\r'], 5000);
    expect(parseResult(stdout)).toBe('deny');
  }, 10_000);

  test('Stray ASCII bytes + ArrowDown + Enter → deny (chars ignored)', async () => {
    if (!libc) { expect(true).toBe(true); return; }
    const { stdout } = await runScenario(libc, ['xyz', '\u001b[B', '\r'], 5000);
    expect(parseResult(stdout)).toBe('deny');
  }, 10_000);

  test('Vietnamese stray UTF-8 ("nhỉ") + ArrowDown + Enter → deny', async () => {
    if (!libc) { expect(true).toBe(true); return; }
    const { stdout } = await runScenario(libc, ['nhỉ', '\u001b[B', '\r'], 5000);
    expect(parseResult(stdout)).toBe('deny');
  }, 10_000);

  test('ArrowDown ×3 (clamped) + Enter → never (last item)', async () => {
    if (!libc) { expect(true).toBe(true); return; }
    const { stdout } = await runScenario(
      libc,
      ['\u001b[B', '\u001b[B', '\u001b[B', '\u001b[B', '\r'],
      5000,
    );
    expect(parseResult(stdout)).toBe('never');
  }, 10_000);

  test('Down, down, up + Enter → deny', async () => {
    if (!libc) { expect(true).toBe(true); return; }
    const { stdout } = await runScenario(
      libc,
      ['\u001b[B', '\u001b[B', '\u001b[A', '\r'],
      5000,
    );
    expect(parseResult(stdout)).toBe('deny');
  }, 10_000);

  test('Chunk-split ANSI (ESC arrives alone, [B arrives later) + Enter → deny', async () => {
    if (!libc) { expect(true).toBe(true); return; }
    // Send bare ESC then the rest after a delay longer than any internal
    // flush. readline.emitKeypressEvents must buffer until it has enough
    // bytes to decide between bare-ESC (Escape key) and CSI sequence.
    // NB: Node's readline actually resolves bare-ESC after a small timeout,
    // so we keep the gap modest (< readline's keypress timeout of 500ms).
    const { stdout } = await runScenario(libc, ['\u001b', '[B', '\r'], 5000);
    expect(parseResult(stdout)).toBe('deny');
  }, 10_000);
});
