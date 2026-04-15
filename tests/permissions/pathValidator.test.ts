// tests/permissions/pathValidator.test.ts — SPEC-401 §6.1 path validator tests.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';
import { __resetPathValidatorCache, validatePath, inspectPath } from '../../src/permissions/pathValidator.ts';

const origNimbusHome = process.env['NIMBUS_HOME'];
let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'nimbus-pv-'));
  process.env['NIMBUS_HOME'] = tmpHome;
  __resetPathValidatorCache();
});

afterAll(() => {
  if (origNimbusHome !== undefined) process.env['NIMBUS_HOME'] = origNimbusHome;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {/* noop */}
  __resetPathValidatorCache();
});

function expectBlocked(fn: () => void, code?: ErrorCode): void {
  try {
    fn();
    throw new Error('expected validatePath to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(NimbusError);
    if (code) expect((err as NimbusError).code).toBe(code);
  }
}

describe('SPEC-401: pathValidator — credentials (T6, T13)', () => {
  test('rejects ~/.ssh/id_rsa as X_CRED_ACCESS', () => {
    const p = resolve(homedir(), '.ssh/id_rsa');
    expectBlocked(() => validatePath(p, undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
  });

  test('rejects .env, .ENV, .Env (case-fold)', () => {
    for (const name of ['.env', '.ENV', '.Env']) {
      expectBlocked(() => validatePath(resolve('/tmp/project', name), undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
    }
  });

  test('rejects .env.local via glob-basename', () => {
    expectBlocked(() => validatePath('/tmp/project/.env.local', undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
  });

  test('rejects ~/.aws/credentials', () => {
    expectBlocked(() => validatePath(resolve(homedir(), '.aws/credentials'), undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
  });

  test('rejects ~/.netrc + ~/.docker/config.json', () => {
    expectBlocked(() => validatePath(resolve(homedir(), '.netrc'), undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
    expectBlocked(() => validatePath(resolve(homedir(), '.docker/config.json'), undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
  });

  test('rejects /etc/shadow with X_CRED_ACCESS', () => {
    expectBlocked(() => validatePath('/etc/shadow', undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
  });

  test('rejects id_ed25519 variants', () => {
    expectBlocked(() => validatePath('/tmp/keys/id_ed25519', undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
    expectBlocked(() => validatePath('/tmp/keys/id_ed25519.pub', undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
  });
});

describe('SPEC-401: pathValidator — shell persistence (T16)', () => {
  test('rejects .bashrc, .ZSHRC, .profile (case-fold)', () => {
    expectBlocked(() => validatePath(resolve(homedir(), '.bashrc'), undefined, { skipSymlinkCheck: true }), ErrorCode.X_PATH_BLOCKED);
    expectBlocked(() => validatePath(resolve(homedir(), '.ZSHRC'), undefined, { skipSymlinkCheck: true }), ErrorCode.X_PATH_BLOCKED);
    expectBlocked(() => validatePath(resolve(homedir(), '.profile'), undefined, { skipSymlinkCheck: true }), ErrorCode.X_PATH_BLOCKED);
  });

  test('rejects /etc/cron.d/mycron', () => {
    expectBlocked(() => validatePath('/etc/cron.d/mycron', undefined, { skipSymlinkCheck: true }), ErrorCode.X_PATH_BLOCKED);
  });

  test('rejects ~/.config/systemd/user/foo.service', () => {
    expectBlocked(() => validatePath(resolve(homedir(), '.config/systemd/user/foo.service'), undefined, { skipSymlinkCheck: true }), ErrorCode.X_PATH_BLOCKED);
  });
});

describe('SPEC-401: pathValidator — nimbus internals (T13, T15)', () => {
  test('rejects secrets.enc + config.json', () => {
    expectBlocked(() => validatePath(resolve(tmpHome, 'secrets.enc'), undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
    expectBlocked(() => validatePath(resolve(tmpHome, 'config.json'), undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
  });

  test('rejects paths inside nimbus logs dir', () => {
    const logsPath = resolve(tmpHome, 'logs', 'audit', '2026-04-15.jsonl');
    expectBlocked(() => validatePath(logsPath, undefined, { skipSymlinkCheck: true }), ErrorCode.X_PATH_BLOCKED);
  });

  test('rejects http.token anywhere via basename', () => {
    expectBlocked(() => validatePath('/tmp/foo/http.token', undefined, { skipSymlinkCheck: true }), ErrorCode.X_CRED_ACCESS);
  });
});

describe('SPEC-401: pathValidator — traversal + edge cases', () => {
  test('rejects relative path', () => {
    expectBlocked(() => validatePath('relative/file.txt', undefined, { skipSymlinkCheck: true }), ErrorCode.X_PATH_BLOCKED);
  });

  test('rejects ../ traversal', () => {
    expectBlocked(() => validatePath('/foo/../../../etc/passwd', undefined, { skipSymlinkCheck: true }), ErrorCode.X_PATH_BLOCKED);
  });

  test('rejects null byte', () => {
    expectBlocked(() => validatePath('/tmp/foo\0bar', undefined, { skipSymlinkCheck: true }), ErrorCode.X_PATH_BLOCKED);
  });

  test('allows innocuous path', () => {
    expect(() => validatePath('/tmp/project/src/main.ts', undefined, { skipSymlinkCheck: true })).not.toThrow();
  });

  test('inspectPath returns matched=true with label for sensitive path', () => {
    const r = inspectPath(resolve(homedir(), '.ssh/id_rsa'));
    expect(r.matched).toBe(true);
    expect(r.code).toBe(ErrorCode.X_CRED_ACCESS);
  });

  test('inspectPath returns matched=false for safe path', () => {
    expect(inspectPath('/tmp/project/src/main.ts').matched).toBe(false);
  });
});

// Windows requires Developer Mode or admin for symlink creation; skip whole block.
// /etc/shadow is Linux-only; that test additionally gated below.
const describeSymlink = process.platform === 'win32' ? describe.skip : describe;

describeSymlink('SPEC-401: pathValidator — symlink TOCTOU guard', () => {
  let workDir: string;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'nimbus-sym-')); });
  afterEach(() => { try { rmSync(workDir, { recursive: true, force: true }); } catch {/* noop */} });

  const testLinuxOnly = process.platform === 'linux' ? test : test.skip;

  testLinuxOnly('rejects symlink pointing at /etc/shadow', () => {
    const link = join(workDir, 'bait.txt');
    try {
      symlinkSync('/etc/shadow', link);
    } catch {
      return;
    }
    expectBlocked(() => validatePath(link), ErrorCode.X_CRED_ACCESS);
  });

  test('rejects symlink pointing at ~/.bashrc', () => {
    const target = resolve(homedir(), '.bashrc');
    // Need a real target; create one if missing so symlink is valid.
    try { writeFileSync(target, '', { flag: 'a' }); } catch { /* best effort */ }
    const link = join(workDir, 'rc.link');
    try {
      symlinkSync(target, link);
    } catch {
      return;
    }
    expectBlocked(() => validatePath(link), ErrorCode.X_PATH_BLOCKED);
  });

  test('symlink into safe path is allowed', () => {
    const dir = join(workDir, 'real');
    mkdirSync(dir);
    const safe = join(dir, 'main.ts');
    writeFileSync(safe, '// x');
    const link = join(workDir, 'safe.link');
    try {
      symlinkSync(safe, link);
    } catch {
      return;
    }
    expect(() => validatePath(link)).not.toThrow();
  });
});
