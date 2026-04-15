// shell.ts — shell detection + POSIX/pwsh/cmd quote adapter (SPEC-151 T3)

import { quote as posixQuote, parse as posixParse } from 'shell-quote';
import { detect } from './detect.ts';
import { NimbusError, ErrorCode } from '../observability/errors.ts';

export interface ShellAdapter {
  readonly kind: 'bash' | 'pwsh' | 'cmd';
  quote(args: string[]): string;
  parseForAudit(cmd: string): string[];
}

export function detectShell(): ShellAdapter {
  const caps = detect();
  const kind = mapToKind(caps.defaultShell, caps.os);
  return makeAdapter(kind);
}

function mapToKind(
  shell: ReturnType<typeof detect>['defaultShell'],
  os: ReturnType<typeof detect>['os'],
): 'bash' | 'pwsh' | 'cmd' {
  if (shell === 'bash' || shell === 'zsh' || shell === 'fish') return 'bash';
  if (shell === 'pwsh') return 'pwsh';
  if (shell === 'cmd') return 'cmd';
  return os === 'win32' ? 'pwsh' : 'bash';
}

function makeAdapter(kind: 'bash' | 'pwsh' | 'cmd'): ShellAdapter {
  if (kind === 'bash') {
    return {
      kind,
      quote: (args) => {
        assertNoNulls(args);
        return posixQuote(args);
      },
      parseForAudit: (cmd) => parsePosix(cmd),
    };
  }
  if (kind === 'pwsh') {
    return {
      kind,
      quote: (args) => {
        assertNoNulls(args);
        return args.map(pwshQuote).join(' ');
      },
      parseForAudit: (cmd) => parsePosix(cmd),
    };
  }
  return {
    kind,
    quote: (args) => {
      assertNoNulls(args);
      return args.map(cmdQuote).join(' ');
    },
    parseForAudit: (cmd) => parsePosix(cmd),
  };
}

function assertNoNulls(args: string[]): void {
  for (const a of args) {
    if (a.includes('\0')) {
      throw new NimbusError(ErrorCode.X_INJECTION, {
        reason: 'null_byte_in_arg',
      });
    }
  }
}

/**
 * PowerShell single-quoted string literal: wrap in `'…'` and double any embedded `'`.
 * PowerShell does NOT expand variables inside single quotes — this is the safest form.
 */
export function pwshQuote(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_\-./:=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "''")}'`;
}

/**
 * cmd.exe quoting: backslash-escape every `"`, then wrap in `"…"`.
 * Reject metacharacters known to break cmd parsing — caller must sanitize upstream.
 */
export function cmdQuote(arg: string): string {
  if (arg === '') return '""';
  if (/[\r\n]/.test(arg)) {
    throw new NimbusError(ErrorCode.X_INJECTION, {
      reason: 'newline_in_cmd_arg',
    });
  }
  if (/^[A-Za-z0-9_\-./:=]+$/.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)"/g, (_, bs: string) => `${bs}${bs}\\"`).replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

function parsePosix(cmd: string): string[] {
  const tokens = posixParse(cmd);
  const out: string[] = [];
  for (const t of tokens) {
    if (typeof t === 'string') out.push(t);
    else if (typeof t === 'object' && t !== null && 'op' in t && typeof (t as { op: unknown }).op === 'string') {
      out.push((t as { op: string }).op);
    } else if (typeof t === 'object' && t !== null && 'pattern' in t) {
      out.push(String((t as { pattern: unknown }).pattern));
    }
  }
  return out;
}
