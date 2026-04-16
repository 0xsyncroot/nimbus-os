// upgradeDetector.ts — detect version change across nimbus boots (SPEC-505)
// Reads/writes ~/.nimbus/installed-version (0644, plain text version string).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nimbusHome } from '../platform/paths.ts';

const INSTALLED_VERSION_FILE = 'installed-version';

function installedVersionPath(): string {
  return join(nimbusHome(), INSTALLED_VERSION_FILE);
}

export async function readInstalledVersion(): Promise<string | null> {
  try {
    const raw = await readFile(installedVersionPath(), { encoding: 'utf8' });
    const v = raw.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function writeInstalledVersion(v: string): Promise<void> {
  const path = installedVersionPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, v, { encoding: 'utf8', mode: 0o644 });
  } catch {
    // best-effort — never block boot
  }
}

/** Minimal changelog entries keyed by target version. */
const UPGRADE_NOTES: Record<string, string> = {
  '0.2.3-alpha': [
    '  • Fixed: P_AUTH on upgrade — vault decrypt auto-recovery on boot',
    '  • New:   `nimbus doctor` — health check for platform, vault, permissions',
    '  • New:   `nimbus vault reset` — re-enter API key after upgrade',
    '  • New:   `nimbus backup create/restore/list` — workspace backup',
    '  • Auto-snapshot: secrets.enc backed up before destructive vault ops',
  ].join('\n'),
};

export async function printUpgradeNote(from: string, to: string): Promise<void> {
  const note = UPGRADE_NOTES[to];
  if (!note) return;
  process.stdout.write(`\nWhat's new in ${to} (from ${from}):\n${note}\n\n`);
}
