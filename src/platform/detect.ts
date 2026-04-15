// detect.ts — OS/arch/WSL/musl detection + PlatformCaps (SPEC-151 T1)

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { NimbusError, ErrorCode } from '../observability/errors.ts';

export const PlatformCapsSchema = z.object({
  os: z.enum(['darwin', 'linux', 'win32']),
  arch: z.enum(['x64', 'arm64']),
  isWSL: z.boolean(),
  isMusl: z.boolean(),
  defaultShell: z.enum(['bash', 'zsh', 'fish', 'pwsh', 'cmd']),
  lineEnding: z.enum(['\n', '\r\n']),
  hasColor: z.boolean(),
});
export type PlatformCaps = z.infer<typeof PlatformCapsSchema>;

let cache: PlatformCaps | null = null;

/** Reset the memo cache. Intended for unit tests only. */
export function __resetDetectCache(): void {
  cache = null;
}

export function detect(): PlatformCaps {
  if (cache) return cache;

  const rawOs = process.platform;
  if (rawOs !== 'darwin' && rawOs !== 'linux' && rawOs !== 'win32') {
    throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
      reason: 'unsupported_os',
      platform: rawOs,
    });
  }

  const rawArch = process.arch;
  if (rawArch !== 'x64' && rawArch !== 'arm64') {
    throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
      reason: 'unsupported_arch',
      arch: rawArch,
    });
  }

  const isWSL = rawOs === 'linux' && detectWSL();
  const isMusl = rawOs === 'linux' && detectMusl();
  const defaultShell = detectDefaultShell(rawOs);
  const lineEnding = rawOs === 'win32' ? '\r\n' : '\n';
  const hasColor = detectColor();

  cache = {
    os: rawOs,
    arch: rawArch,
    isWSL,
    isMusl,
    defaultShell,
    lineEnding,
    hasColor,
  };
  return cache;
}

function detectWSL(): boolean {
  if (process.env['WSL_DISTRO_NAME']) return true;
  try {
    const txt = readFileSync('/proc/version', 'utf8').toLowerCase();
    return txt.includes('microsoft') || txt.includes('wsl');
  } catch {
    return false;
  }
}

function detectMusl(): boolean {
  try {
    const txt = readFileSync('/proc/self/maps', 'utf8');
    if (/\/ld-musl-/.test(txt)) return true;
    if (/\/libc\.musl-/.test(txt)) return true;
    return false;
  } catch {
    return false;
  }
}

function detectDefaultShell(os: 'darwin' | 'linux' | 'win32'): PlatformCaps['defaultShell'] {
  const override = process.env['NIMBUS_SHELL'];
  if (override) {
    const norm = normalizeShellName(override);
    if (norm) return norm;
  }

  if (os === 'win32') {
    if (process.env['MSYSTEM']) return 'bash';
    const comspec = process.env['ComSpec']?.toLowerCase() ?? '';
    if (comspec.endsWith('cmd.exe')) return 'cmd';
    return 'pwsh';
  }

  const shellEnv = process.env['SHELL'] ?? '';
  const norm = normalizeShellName(shellEnv);
  return norm ?? (os === 'darwin' ? 'zsh' : 'bash');
}

function normalizeShellName(raw: string): PlatformCaps['defaultShell'] | null {
  const base = raw.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
  if (base === 'bash' || base === 'sh') return 'bash';
  if (base === 'zsh') return 'zsh';
  if (base === 'fish') return 'fish';
  if (base === 'pwsh' || base === 'powershell') return 'pwsh';
  if (base === 'cmd') return 'cmd';
  return null;
}

function detectColor(): boolean {
  if (process.env['NO_COLOR']) return false;
  if (process.env['FORCE_COLOR']) return true;
  return Boolean(process.stdout?.isTTY);
}
