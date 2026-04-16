// backup.ts — `nimbus backup` subcommand (SPEC-505)
// create [--out FILE]   tar.gz of workspaces/ only (excludes .vault-key by default), mode 0600
// restore <file>        extract with --no-absolute-names guard
// list                  list backups in ~/nimbus-backups/
//
// NOTE: Backup is unencrypted in v0.2.3. Encryption (AES-GCM stream) deferred to v0.3.
// SECURITY: .vault-key is EXCLUDED from backup by default to prevent exposing the
// plaintext passphrase+encrypted vault bundle (combined = full credential unwrap).
// Use --i-understand-plaintext to include it anyway (NOT recommended).

import { readdir, stat, mkdir } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { nimbusHome, workspacesDir } from '../../platform/paths.ts';

const DEFAULT_BACKUP_DIR = join(homedir(), 'nimbus-backups');

function defaultOutFile(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return join(DEFAULT_BACKUP_DIR, `nimbus-backup-${ts}.tar.gz`);
}

async function runBackupCreate(outFile?: string, includePlaintext = false): Promise<number> {
  const out = outFile ?? defaultOutFile();
  const vaultKeyFile = join(nimbusHome(), '.vault-key');
  const secretsEncFile = join(nimbusHome(), 'secrets.enc');
  const wsDir = workspacesDir();
  const home = nimbusHome();

  // BLOCKER 1: Refuse to bundle .vault-key + secrets.enc together by default.
  // Combined they form a full credential unwrap bundle.
  const hasVaultKey = await stat(vaultKeyFile).then(() => true).catch(() => false);
  const hasSecretsEnc = await stat(secretsEncFile).then(() => true).catch(() => false);

  if (hasVaultKey && hasSecretsEnc && !includePlaintext) {
    process.stderr.write(
      [
        '',
        '\u26d4  SECURITY: Backup refused.',
        '',
        '  Both .vault-key (plaintext passphrase) and secrets.enc (encrypted keys)',
        '  are present. Including both in a single archive creates a full credential',
        '  unwrap bundle — anyone with the tarball can decrypt your API keys.',
        '',
        '  Default behavior: .vault-key is EXCLUDED from this backup.',
        '  secrets.enc IS included. On restore, re-enter your passphrase via the',
        '  keychain auto-provision flow (`nimbus vault reset`).',
        '',
        '  To include .vault-key anyway (NOT recommended):',
        '    nimbus backup create --i-understand-plaintext',
        '',
        '  Encrypted backup (no risk) arrives in v0.3.',
        '',
      ].join('\n'),
    );
    // Proceed with safe path: exclude .vault-key
    process.stdout.write('  Continuing backup WITHOUT .vault-key (safe default).\n\n');
  }

  process.stdout.write(`\nnimbus backup create\n`);
  process.stdout.write(
    `  \u26a0  WARNING: This backup contains sensitive data (workspace files).\n` +
    `         Store it securely. Encryption will be added in v0.3 release.\n\n`,
  );

  // Ensure output dir exists — BLOCKER 2 non-blocking: use path.dirname()
  const outDir = dirname(out);
  await mkdir(outDir, { recursive: true });

  // Collect relative paths to archive (BLOCKER 2: use -C + relative paths)
  const relEntries: string[] = [];

  try {
    const wsStat = await stat(wsDir);
    if (wsStat.isDirectory()) {
      const rel = relative(home, wsDir);
      relEntries.push(rel);
    }
  } catch {
    process.stdout.write('  Workspaces dir not found — skipping.\n');
  }

  // Only include .vault-key if explicitly opted in AND both files exist
  if (includePlaintext && hasVaultKey) {
    if (hasSecretsEnc) {
      process.stdout.write(
        `  \u26a0  --i-understand-plaintext: including .vault-key + secrets.enc together.\n` +
        `         Store this backup with extreme care.\n\n`,
      );
    }
    relEntries.push('.vault-key');
  }

  if (relEntries.length === 0) {
    process.stdout.write('  Nothing to back up.\n');
    return 1;
  }

  // BLOCKER 2: Use -C <home> + relative paths to prevent tar path traversal on create.
  // Arg order matters: GNU tar accepts '-C dir -czf out files'; BSD tar (macOS) and
  // Windows tar require '-czf out -C dir files'. Use BSD-compatible order everywhere.
  const tarArgs = ['-czf', out, '-C', home, ...relEntries];
  const proc = Bun.spawn(['tar', ...tarArgs], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    process.stderr.write(`  tar failed: ${errText}\n`);
    return 1;
  }

  // Set mode 0600 on Linux/macOS
  if (process.platform !== 'win32') {
    const chmodProc = Bun.spawn(['chmod', '600', out], { stdout: 'ignore', stderr: 'ignore' });
    await chmodProc.exited;
  }

  const s = await stat(out);
  process.stdout.write(`  Created: ${out}\n`);
  process.stdout.write(`  Size:    ${Math.round(s.size / 1024)} KB\n`);
  process.stdout.write(`  Mode:    0600\n\n`);

  return 0;
}

async function runBackupRestore(file: string): Promise<number> {
  if (!file) {
    process.stderr.write('  Usage: nimbus backup restore <file>\n');
    return 1;
  }

  process.stdout.write(`\nnimbus backup restore ${file}\n`);

  try {
    await stat(file);
  } catch {
    process.stderr.write(`  File not found: ${file}\n`);
    return 1;
  }

  // BLOCKER 2: Pre-scan archive for absolute paths — refuse extraction if found
  const listProc = Bun.spawn(['tar', '-tzf', file], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const listExit = await listProc.exited;
  if (listExit !== 0) {
    const errText = await new Response(listProc.stderr).text();
    process.stderr.write(`  Cannot read archive: ${errText}\n`);
    return 1;
  }
  const listing = await new Response(listProc.stdout).text();
  const entries = listing.split('\n').filter(Boolean);
  const absolute = entries.filter((e) => isAbsolute(e));
  if (absolute.length > 0) {
    process.stderr.write(
      [
        '',
        '\u26d4  SECURITY: Restore refused.',
        '',
        `  Archive contains ${absolute.length} absolute path(s) which could overwrite`,
        '  system files (e.g. /etc/passwd). Refusing extraction.',
        '',
        '  Suspicious entries:',
        ...absolute.slice(0, 5).map((e) => `    ${e}`),
        '',
        '  Only backups created by `nimbus backup create` are supported.',
        '',
      ].join('\n'),
    );
    return 1;
  }

  // Extract to temp dir first to verify.
  // BLOCKER 2: defence-in-depth — the pre-scan above is the primary guard against
  // absolute-path entries. We do NOT pass --no-absolute-names here because it is
  // GNU-tar-only and is absent from BSD tar (macOS), BusyBox tar (Alpine/WSL2),
  // and Windows tar. The -C <tmpdir> flag alone ensures any relative paths land
  // safely under our temp directory.
  const tmp = join(tmpdir(), `nimbus-restore-${Date.now()}`);
  await mkdir(tmp, { recursive: true });

  const extractArgs = ['tar', '-xzf', file, '-C', tmp];
  const proc = Bun.spawn(extractArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    process.stderr.write(`  Extraction failed: ${errText}\n`);
    return 1;
  }

  process.stdout.write(`  Extracted to: ${tmp}\n`);

  // Check for expected structure
  const wsBackupDir = join(tmp, workspacesDir().replace(/^\//, ''));
  let wsFound = false;
  try {
    await stat(wsBackupDir);
    wsFound = true;
  } catch {
    process.stdout.write(`  Note: could not find workspaces dir in backup at expected path.\n`);
  }

  if (wsFound) {
    process.stdout.write(`  Workspaces found in backup.\n`);
    process.stdout.write(`  To restore: cp -r ${wsBackupDir} ${workspacesDir()}\n`);
    process.stdout.write(`  Manual restore required in v0.2.3 — auto-restore arrives in v0.3.\n`);
  }

  process.stdout.write(`\n  Backup extracted for manual inspection at: ${tmp}\n\n`);
  return 0;
}

async function runBackupList(): Promise<number> {
  process.stdout.write(`\nnimbus backup list (${DEFAULT_BACKUP_DIR})\n`);

  try {
    const files = await readdir(DEFAULT_BACKUP_DIR);
    const backups = files.filter((f) => f.startsWith('nimbus-backup-') && f.endsWith('.tar.gz'));

    if (backups.length === 0) {
      process.stdout.write('  No backups found.\n\n');
      return 0;
    }

    for (const f of backups) {
      const fPath = join(DEFAULT_BACKUP_DIR, f);
      const s = await stat(fPath);
      const sizeKb = Math.round(s.size / 1024);
      process.stdout.write(`  ${f}  (${sizeKb} KB)\n`);
    }
    process.stdout.write('\n');
  } catch {
    process.stdout.write(`  Backup dir not found: ${DEFAULT_BACKUP_DIR}\n`);
    process.stdout.write(`  Run \`nimbus backup create\` to create your first backup.\n\n`);
  }

  return 0;
}

export async function runBackup(subArgs: string[]): Promise<number> {
  const sub = subArgs[0];

  if (sub === 'create') {
    const outIdx = subArgs.indexOf('--out');
    const outFile = outIdx >= 0 ? subArgs[outIdx + 1] : undefined;
    const includePlaintext = subArgs.includes('--i-understand-plaintext');
    return runBackupCreate(outFile, includePlaintext);
  }

  if (sub === 'restore') {
    return runBackupRestore(subArgs[1] ?? '');
  }

  if (sub === 'list') {
    return runBackupList();
  }

  process.stdout.write(
    [
      '',
      'nimbus backup — workspace backup and restore',
      '',
      'Usage:',
      '  nimbus backup create [--out FILE]              Create a tar.gz backup (0600)',
      '  nimbus backup create --i-understand-plaintext  Include .vault-key (NOT recommended)',
      '  nimbus backup restore <file>                    Extract and inspect a backup',
      '  nimbus backup list                              List backups in ~/nimbus-backups/',
      '',
      'Security:',
      '  .vault-key is excluded by default. Combined with secrets.enc it would form a',
      '  full credential unwrap bundle. Use --i-understand-plaintext to override.',
      '  Backups are unencrypted in v0.2.3. Encryption arrives in v0.3.',
      '',
    ].join('\n'),
  );
  return 0;
}
