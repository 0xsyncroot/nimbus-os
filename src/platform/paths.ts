// paths.ts — per-OS config/cache/data/logs/state dirs + NIMBUS_HOME override (SPEC-151 T2)

import { homedir } from 'node:os';
import { join, normalize, isAbsolute, sep } from 'node:path';
import { NimbusError, ErrorCode } from '../observability/errors.ts';
import { detect } from './detect.ts';

const APP = 'nimbus';

function overrideHome(): string | null {
  const raw = process.env['NIMBUS_HOME'];
  if (!raw) return null;
  if (!isAbsolute(raw)) {
    throw new NimbusError(ErrorCode.X_PATH_BLOCKED, {
      reason: 'nimbus_home_not_absolute',
      value: raw,
    });
  }
  if (raw.split(/[\\/]/).includes('..')) {
    throw new NimbusError(ErrorCode.X_PATH_BLOCKED, {
      reason: 'nimbus_home_contains_traversal',
      value: raw,
    });
  }
  return normalize(raw);
}

function home(): string {
  return homedir();
}

export function nimbusHome(): string {
  const ovr = overrideHome();
  if (ovr) return ovr;
  const caps = detect();
  if (caps.os === 'darwin') {
    return join(home(), 'Library', 'Application Support', APP);
  }
  if (caps.os === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home(), 'AppData', 'Roaming');
    return join(appData, APP);
  }
  const xdgData = process.env['XDG_DATA_HOME'] ?? join(home(), '.local', 'share');
  return join(xdgData, APP);
}

export function configDir(): string {
  const ovr = overrideHome();
  if (ovr) return join(ovr, 'config');
  const caps = detect();
  if (caps.os === 'darwin') {
    return join(home(), 'Library', 'Application Support', APP);
  }
  if (caps.os === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home(), 'AppData', 'Roaming');
    return join(appData, APP);
  }
  const xdg = process.env['XDG_CONFIG_HOME'] ?? join(home(), '.config');
  return join(xdg, APP);
}

export function cacheDir(): string {
  const ovr = overrideHome();
  if (ovr) return join(ovr, 'cache');
  const caps = detect();
  if (caps.os === 'darwin') return join(home(), 'Library', 'Caches', APP);
  if (caps.os === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(home(), 'AppData', 'Local');
    return join(local, APP, 'Cache');
  }
  const xdg = process.env['XDG_CACHE_HOME'] ?? join(home(), '.cache');
  return join(xdg, APP);
}

export function dataDir(): string {
  const ovr = overrideHome();
  if (ovr) return join(ovr, 'data');
  return nimbusHome();
}

export function logsDir(): string {
  const ovr = overrideHome();
  if (ovr) return join(ovr, 'logs');
  const caps = detect();
  if (caps.os === 'darwin') return join(home(), 'Library', 'Logs', APP);
  if (caps.os === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(home(), 'AppData', 'Local');
    return join(local, APP, 'Logs');
  }
  const xdgState = process.env['XDG_STATE_HOME'] ?? join(home(), '.local', 'state');
  return join(xdgState, APP, 'logs');
}

export function stateDir(): string {
  const ovr = overrideHome();
  if (ovr) return join(ovr, 'state');
  const caps = detect();
  if (caps.os === 'darwin') return join(home(), 'Library', 'Application Support', APP, 'state');
  if (caps.os === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(home(), 'AppData', 'Local');
    return join(local, APP, 'State');
  }
  const xdgState = process.env['XDG_STATE_HOME'] ?? join(home(), '.local', 'state');
  return join(xdgState, APP);
}

export function workspacesDir(): string {
  return join(dataDir(), 'workspaces');
}

export function tempDir(): string {
  const ovr = overrideHome();
  if (ovr) return join(ovr, 'tmp');
  return join(cacheDir(), 'tmp');
}
