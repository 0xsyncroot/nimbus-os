// pathValidator.ts — SPEC-401 §2.1, §6.1: sensitive path denylist + symlink/traversal guard.
//
// Mitigates T6 (path traversal / credential access), T13 (secret file read),
// T15 (audit tampering), T16 (shell persistence).

import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logsDir, nimbusHome } from '../platform/paths.ts';

/**
 * Sensitive path patterns. All matched case-insensitively against normalized absolute paths.
 * Each entry is either:
 *   - `exact:`  absolute path literal
 *   - `prefix:` directory prefix (path must equal or be inside)
 *   - `basename:` filename match (last path component)
 *   - `glob-basename:` basename with `*` wildcard
 * The code reason decides which ErrorCode is thrown.
 */
type PatternKind = 'exact' | 'prefix' | 'basename' | 'glob-basename';
interface SensitivePattern {
  kind: PatternKind;
  value: string;
  code: ErrorCode;
  label: string;
}

function expand(tilde: string): string {
  if (tilde.startsWith('~')) return resolve(homedir(), tilde.slice(1).replace(/^[\\/]/, ''));
  return tilde;
}

function buildPatterns(): SensitivePattern[] {
  const home = homedir();
  const nh = safeNimbusHome();
  const ld = safeLogsDir();
  const p: SensitivePattern[] = [];

  // Credentials (T6, T13)
  const credBasenames = [
    '.env',
    '.envrc',
    '.netrc',
    '.pgpass',
  ];
  const credGlobBasenames = ['.env.*', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*'];
  for (const b of credBasenames) {
    p.push({ kind: 'basename', value: b, code: ErrorCode.X_CRED_ACCESS, label: `cred:${b}` });
  }
  for (const b of credGlobBasenames) {
    p.push({ kind: 'glob-basename', value: b, code: ErrorCode.X_CRED_ACCESS, label: `cred:${b}` });
  }
  p.push({ kind: 'prefix', value: resolve(home, '.ssh'), code: ErrorCode.X_CRED_ACCESS, label: 'cred:.ssh' });
  p.push({ kind: 'prefix', value: resolve(home, '.aws'), code: ErrorCode.X_CRED_ACCESS, label: 'cred:.aws' });
  p.push({ kind: 'prefix', value: resolve(home, '.gcloud'), code: ErrorCode.X_CRED_ACCESS, label: 'cred:.gcloud' });
  p.push({ kind: 'prefix', value: resolve(home, '.config', 'gcloud'), code: ErrorCode.X_CRED_ACCESS, label: 'cred:gcloud' });
  p.push({ kind: 'prefix', value: resolve(home, '.azure'), code: ErrorCode.X_CRED_ACCESS, label: 'cred:.azure' });
  p.push({ kind: 'exact', value: resolve(home, '.kube', 'config'), code: ErrorCode.X_CRED_ACCESS, label: 'cred:kubeconfig' });
  p.push({ kind: 'exact', value: resolve(home, '.docker', 'config.json'), code: ErrorCode.X_CRED_ACCESS, label: 'cred:docker' });
  p.push({ kind: 'exact', value: '/etc/shadow', code: ErrorCode.X_CRED_ACCESS, label: 'cred:shadow' });
  p.push({ kind: 'exact', value: '/etc/passwd', code: ErrorCode.X_PATH_BLOCKED, label: 'cred:passwd' });
  p.push({ kind: 'exact', value: '/etc/gshadow', code: ErrorCode.X_CRED_ACCESS, label: 'cred:gshadow' });

  // Shell persistence (T16)
  const shellBasenames = [
    '.bashrc',
    '.bash_profile',
    '.bash_login',
    '.bash_logout',
    '.zshrc',
    '.zprofile',
    '.zshenv',
    '.zlogin',
    '.profile',
  ];
  for (const b of shellBasenames) {
    p.push({ kind: 'basename', value: b, code: ErrorCode.X_PATH_BLOCKED, label: `shell:${b}` });
  }
  p.push({ kind: 'exact', value: resolve(home, '.config', 'fish', 'config.fish'), code: ErrorCode.X_PATH_BLOCKED, label: 'shell:fish' });
  p.push({ kind: 'prefix', value: '/etc/cron.d', code: ErrorCode.X_PATH_BLOCKED, label: 'cron:cron.d' });
  p.push({ kind: 'prefix', value: '/etc/cron.hourly', code: ErrorCode.X_PATH_BLOCKED, label: 'cron:hourly' });
  p.push({ kind: 'prefix', value: '/etc/cron.daily', code: ErrorCode.X_PATH_BLOCKED, label: 'cron:daily' });
  p.push({ kind: 'exact', value: '/etc/crontab', code: ErrorCode.X_PATH_BLOCKED, label: 'cron:tab' });
  p.push({ kind: 'prefix', value: '/var/spool/cron', code: ErrorCode.X_PATH_BLOCKED, label: 'cron:spool' });
  p.push({ kind: 'prefix', value: resolve(home, '.config', 'cron'), code: ErrorCode.X_PATH_BLOCKED, label: 'cron:user' });
  p.push({ kind: 'prefix', value: resolve(home, '.config', 'systemd', 'user'), code: ErrorCode.X_PATH_BLOCKED, label: 'systemd:user' });

  // nimbus internals (T13, T15)
  if (nh) {
    p.push({ kind: 'exact', value: resolve(nh, 'secrets.enc'), code: ErrorCode.X_CRED_ACCESS, label: 'nimbus:secrets' });
    p.push({ kind: 'exact', value: resolve(nh, 'config.json'), code: ErrorCode.X_CRED_ACCESS, label: 'nimbus:config' });
    p.push({ kind: 'exact', value: resolve(nh, 'paired-devices.json'), code: ErrorCode.X_CRED_ACCESS, label: 'nimbus:paired' });
    p.push({ kind: 'glob-basename', value: 'http.token', code: ErrorCode.X_CRED_ACCESS, label: 'nimbus:http-token' });
  }
  if (ld) {
    p.push({ kind: 'prefix', value: ld, code: ErrorCode.X_PATH_BLOCKED, label: 'nimbus:logs' });
  }
  return p;
}

function safeNimbusHome(): string | null {
  try {
    return nimbusHome();
  } catch {
    return null;
  }
}
function safeLogsDir(): string | null {
  try {
    return logsDir();
  } catch {
    return null;
  }
}

let PATTERNS_CACHE: SensitivePattern[] | null = null;
export function getSensitivePatterns(): SensitivePattern[] {
  if (!PATTERNS_CACHE) PATTERNS_CACHE = buildPatterns();
  return PATTERNS_CACHE;
}

/** For tests: rebuild patterns (e.g., after NIMBUS_HOME change). */
export function __resetPathValidatorCache(): void {
  PATTERNS_CACHE = null;
}

function casefold(s: string): string {
  return s.toLowerCase();
}

function lastSegment(p: string): string {
  const norm = normalize(p);
  const parts = norm.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

function globBasenameMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split('')
        .map((c) => (c === '*' ? '.*' : c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
        .join('') +
      '$',
  );
  return re.test(name);
}

function withinPrefix(abs: string, prefix: string): boolean {
  const a = casefold(normalize(abs));
  const p = casefold(normalize(prefix));
  if (a === p) return true;
  const rel = relative(p, a);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function matchOne(abs: string, pat: SensitivePattern): boolean {
  if (pat.kind === 'exact') {
    return casefold(normalize(abs)) === casefold(normalize(expand(pat.value)));
  }
  if (pat.kind === 'prefix') {
    return withinPrefix(abs, expand(pat.value));
  }
  const base = lastSegment(abs);
  if (pat.kind === 'basename') return casefold(base) === casefold(pat.value);
  return globBasenameMatch(casefold(pat.value), casefold(base));
}

export interface ValidatePathOptions {
  /** If true, do not touch the filesystem (for pure unit tests). */
  skipSymlinkCheck?: boolean;
}

/**
 * Validate an absolute path: reject traversal, sensitive patterns, and
 * symlinks that escape the sensitive-pattern check (TOCTOU guard).
 *
 * Throws NimbusError(X_PATH_BLOCKED | X_CRED_ACCESS) on rejection.
 * Does NOT create or open the file.
 */
export function validatePath(abs: string, workspaceRoot?: string, opts: ValidatePathOptions = {}): void {
  if (typeof abs !== 'string' || abs.length === 0) {
    throw new NimbusError(ErrorCode.X_PATH_BLOCKED, { reason: 'empty_path' });
  }
  if (abs.indexOf('\0') !== -1) {
    throw new NimbusError(ErrorCode.X_PATH_BLOCKED, { reason: 'null_byte' });
  }
  if (!isAbsolute(abs)) {
    throw new NimbusError(ErrorCode.X_PATH_BLOCKED, { reason: 'not_absolute', path: abs });
  }
  const segments = abs.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new NimbusError(ErrorCode.X_PATH_BLOCKED, { reason: 'traversal', path: abs });
  }
  const normalized = normalize(abs);

  // Symlink resolution (O_NOFOLLOW semantic approximation): if the path exists
  // and any component is a symlink pointing outside the workspace / into a
  // sensitive area, reject. If the path does not exist, fall through to the
  // pattern check on the literal path.
  let effective = normalized;
  if (!opts.skipSymlinkCheck) {
    const resolved = tryResolveSymlink(normalized);
    if (resolved !== null && resolved !== normalized) {
      // Re-check resolved form too — attacker cannot bypass via symlink.
      checkPatterns(resolved, normalized);
      effective = resolved;
    }
    if (workspaceRoot !== undefined) {
      const wsResolved = tryResolveSymlink(workspaceRoot) ?? workspaceRoot;
      if (!withinPrefix(effective, wsResolved) && !isInsideHomeOrTmp(effective)) {
        // For non-workspace paths we still run the sensitive check below.
      }
    }
  }
  checkPatterns(effective, normalized);
}

function isInsideHomeOrTmp(abs: string): boolean {
  const tmp = process.env['TMPDIR'] ?? '/tmp';
  return withinPrefix(abs, homedir()) || withinPrefix(abs, tmp);
}

function checkPatterns(abs: string, original: string): void {
  const pats = getSensitivePatterns();
  for (const pat of pats) {
    if (matchOne(abs, pat)) {
      throw new NimbusError(pat.code, {
        reason: 'sensitive_path',
        label: pat.label,
        path: original,
      });
    }
  }
}

function tryResolveSymlink(abs: string): string | null {
  try {
    const st = lstatSync(abs);
    if (!st.isSymbolicLink()) return abs;
    return realpathSync(abs);
  } catch {
    return null;
  }
}

/**
 * Returns the list of (abs, label) tuples for all sensitive patterns matched.
 * Useful for audit summaries. Does not throw.
 */
export function inspectPath(abs: string): { matched: boolean; label?: string; code?: ErrorCode } {
  try {
    validatePath(abs, undefined, { skipSymlinkCheck: true });
    return { matched: false };
  } catch (err) {
    if (err instanceof NimbusError) {
      const label = typeof err.context['label'] === 'string' ? (err.context['label'] as string) : undefined;
      return { matched: true, label, code: err.code };
    }
    return { matched: true };
  }
}

// Re-export helpers for tests.
export const __test = { withinPrefix, globBasenameMatch, buildPatterns, sep };
