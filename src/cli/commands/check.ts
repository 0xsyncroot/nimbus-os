// check.ts — `nimbus check` — unified system check (SPEC-828)
// Composes doctor + health + vault diagnose into one rolled-up report.

import { detect } from '../../platform/detect.ts';
import { diagnoseVault } from '../../platform/secrets/diagnose.ts';
import { getActiveWorkspace } from '../../core/workspace.ts';
import { freemem } from 'node:os';

type SectionStatus = 'OK' | 'WARN' | 'FAIL';

function icon(s: SectionStatus): string {
  if (s === 'OK') return 'OK';
  if (s === 'WARN') return 'WARN';
  return 'FAIL';
}

function line(label: string, value: string, s: SectionStatus): string {
  return `  ${label.padEnd(20)} ${value.padEnd(24)} ${icon(s)}\n`;
}

export async function runCheck(_args: string[]): Promise<number> {
  let overallOk = true;

  // ▸ System
  process.stdout.write('▸ System\n');
  try {
    const caps = detect();
    process.stdout.write(line('Platform', `${caps.os}-${caps.arch}`, 'OK'));
  } catch (err) {
    process.stdout.write(line('Platform', 'error', 'FAIL'));
    process.stderr.write(`  ${(err as Error).message}\n`);
    overallOk = false;
  }

  const bunVer = process.versions.bun ?? 'unknown';
  const bunStatus: SectionStatus = bunVer !== 'unknown' ? 'OK' : 'WARN';
  if (bunStatus !== 'OK') overallOk = false;
  process.stdout.write(line('Bun', `${bunVer}`, bunStatus));

  const memMb = Math.round(freemem() / 1024 / 1024);
  const memStatus: SectionStatus = memMb < 50 ? 'FAIL' : memMb < 200 ? 'WARN' : 'OK';
  if (memStatus === 'FAIL') overallOk = false;
  process.stdout.write(line('Memory free', `${memMb} MB`, memStatus));

  process.stdout.write('\n');

  // ▸ Workspace
  process.stdout.write('▸ Workspace\n');
  try {
    const ws = await getActiveWorkspace();
    if (ws) {
      process.stdout.write(line('Workspace', ws.id, 'OK'));
      process.stdout.write(line('Schema version', `v${String(ws.schemaVersion)}`, 'OK'));
    } else {
      process.stdout.write(line('Workspace', 'none — run nimbus init', 'WARN'));
      process.stdout.write(line('Schema version', 'N/A', 'WARN'));
      overallOk = false;
    }
  } catch (err) {
    process.stdout.write(line('Workspace', 'error', 'FAIL'));
    process.stderr.write(`  ${(err as Error).message}\n`);
    overallOk = false;
  }

  process.stdout.write('\n');

  // ▸ Vault
  process.stdout.write('▸ Vault\n');
  const vaultStatus = await diagnoseVault();
  if (vaultStatus.ok) {
    process.stdout.write(line('Present', 'yes', 'OK'));
    process.stdout.write(line('Decrypt', 'OK', 'OK'));
  } else if (vaultStatus.reason === 'missing_file') {
    process.stdout.write(line('Present', 'no (no keys yet)', 'WARN'));
    process.stdout.write(line('Decrypt', 'N/A', 'WARN'));
    // Not a failure — user just hasn't stored a key yet
  } else if (vaultStatus.reason === 'missing_passphrase') {
    process.stdout.write(line('Present', 'yes', 'OK'));
    process.stdout.write(line('Decrypt', 'FAIL — passphrase missing', 'FAIL'));
    process.stderr.write('  Fix: nimbus debug vault reset\n');
    overallOk = false;
  } else {
    process.stdout.write(line('Present', 'yes', 'OK'));
    process.stdout.write(line('Decrypt', `FAIL — ${vaultStatus.reason}`, 'FAIL'));
    process.stderr.write('  Fix: nimbus debug vault reset\n');
    overallOk = false;
  }

  process.stdout.write('\n');

  if (overallOk) {
    process.stdout.write('Tất cả OK.\n');
    return 0;
  }

  process.stdout.write('Issues found. See WARN/FAIL rows above.\n');
  return 1;
}
