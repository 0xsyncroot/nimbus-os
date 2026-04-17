// doctor.ts — `nimbus debug doctor` health check command (SPEC-505)
// Read-only. Exit 0 if all OK, 1 if issues found. No --fix in v0.2.3.
// Moved from src/cli/commands/doctor.ts (SPEC-828).

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { nimbusHome } from '../../platform/paths.ts';
import { detect } from '../../platform/detect.ts';
import { diagnoseVault } from '../../platform/secrets/diagnose.ts';
import { getActiveWorkspace } from '../../core/workspace.ts';

const VAULT_KEY_FILENAME = '.vault-key';
const CURRENT_VERSION = '0.3.13-alpha';

interface CheckRow {
  label: string;
  value: string;
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
  fix?: string;
}

function row(label: string, value: string, status: CheckRow['status'], detail?: string, fix?: string): CheckRow {
  return { label, value, status, detail, fix };
}

function pad(s: string, n: number): string {
  return s.padEnd(n, ' ');
}

function statusIcon(s: CheckRow['status']): string {
  if (s === 'ok') return 'OK';
  if (s === 'warn') return 'WARN';
  return 'FAIL';
}

function printTable(rows: CheckRow[]): void {
  const labelW = Math.max(...rows.map((r) => r.label.length)) + 2;
  const valueW = Math.max(...rows.map((r) => r.value.length)) + 2;
  const sep = '-'.repeat(labelW + valueW + 8);

  process.stdout.write(`nimbus doctor ${CURRENT_VERSION}\n`);
  process.stdout.write(`${sep}\n`);
  for (const r of rows) {
    const icon = statusIcon(r.status);
    process.stdout.write(`${pad(r.label, labelW)}${pad(r.value, valueW)}${icon}\n`);
  }
  process.stdout.write(`${sep}\n`);
}

function printIssues(issues: CheckRow[]): void {
  const count = issues.length;
  process.stdout.write(`\n  \u26a0  ${count} issue${count > 1 ? 's' : ''} found\n\n`);
  for (const issue of issues) {
    process.stdout.write(`  ${issue.label} ${issue.status === 'warn' ? 'WARNING' : 'FAILED'}\n`);
    if (issue.detail) process.stdout.write(`    Cause: ${issue.detail}\n`);
    if (issue.fix) process.stdout.write(`    Fix:   ${issue.fix}\n`);
    process.stdout.write('\n');
  }
}

export async function runDoctor(): Promise<number> {
  const rows: CheckRow[] = [];

  // Platform
  try {
    const caps = detect();
    rows.push(row('Platform', `${caps.os}-${caps.arch}`, 'ok'));
  } catch (err) {
    rows.push(row('Platform', 'error', 'fail', (err as Error).message));
  }

  // Bun runtime
  const bunVersion = process.versions.bun ?? 'unknown';
  rows.push(row('Bun runtime', bunVersion, bunVersion !== 'unknown' ? 'ok' : 'warn'));

  // Workspace
  try {
    const ws = await getActiveWorkspace();
    if (ws) {
      rows.push(row('Workspace', `${ws.id} (default)`, 'ok'));
      const sv: number = ws.schemaVersion;
      const svStr = `v${String(sv)} (current)`;
      rows.push(row('Schema version', svStr, 'ok'));
    } else {
      rows.push(row('Workspace', 'none', 'warn', 'No workspace found', 'nimbus init'));
      rows.push(row('Schema version', 'N/A', 'warn'));
    }
  } catch (err) {
    rows.push(row('Workspace', 'error', 'fail', (err as Error).message));
    rows.push(row('Schema version', 'error', 'fail'));
  }

  // Vault file + decrypt
  const vaultStatus = await diagnoseVault();
  if (vaultStatus.ok) {
    rows.push(row('Vault file', 'present', 'ok'));
    rows.push(row('Vault decrypt', 'ok', 'ok'));
  } else if (vaultStatus.reason === 'missing_file') {
    rows.push(row('Vault file', 'absent', 'warn', 'No secrets stored yet'));
    rows.push(row('Vault decrypt', 'N/A', 'warn'));
  } else if (vaultStatus.reason === 'missing_passphrase') {
    rows.push(row('Vault file', 'present', 'ok'));
    rows.push(row('Vault decrypt', 'FAIL', 'fail', 'passphrase not found', 'nimbus vault reset'));
  } else if (vaultStatus.reason === 'decrypt_failed') {
    rows.push(row('Vault file', 'present', 'ok'));
    rows.push(row('Vault decrypt', 'FAIL', 'fail', 'likely v0.2.1 → v0.2.2 upgrade', 'nimbus vault reset   (re-enters keys inline)'));
  } else {
    rows.push(row('Vault file', 'present', 'ok'));
    rows.push(row('Vault decrypt', 'FAIL', 'fail', vaultStatus.reason, 'nimbus vault reset'));
  }

  // .vault-key permissions (Unix only)
  if (process.platform !== 'win32') {
    const vkPath = join(nimbusHome(), VAULT_KEY_FILENAME);
    try {
      const st = await stat(vkPath);
      const mode = (st.mode & 0o777).toString(8).padStart(4, '0');
      if (st.mode & 0o077) {
        rows.push(row('.vault-key perm', mode, 'warn',
          `expected 0600, got ${mode}`,
          `chmod 600 ${vkPath}`));
      } else {
        rows.push(row('.vault-key perm', '0600', 'ok'));
      }
    } catch {
      rows.push(row('.vault-key perm', 'absent', 'warn', 'No .vault-key file (file-fallback not yet used)'));
    }
  }

  printTable(rows);

  const issues = rows.filter((r) => r.status !== 'ok');
  if (issues.length === 0) {
    process.stdout.write('\nAll systems OK.\n');
    return 0;
  }

  printIssues(issues);
  return 1;
}
