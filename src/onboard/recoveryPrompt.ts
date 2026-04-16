// recoveryPrompt.ts — Interactive recovery UX for vault failures at startup (SPEC-505)
// Handles each VaultStatus reason with a human-friendly prompt + guided fix.

import { unlink, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { nimbusHome } from '../platform/paths.ts';
import type { VaultStatus, VaultStatusReason } from '../platform/secrets/diagnose.ts';

const VAULT_FILENAME = 'secrets.enc';

function vaultPath(): string {
  return join(nimbusHome(), VAULT_FILENAME);
}

function brokenBackupPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(nimbusHome(), `secrets.broken-${ts}.enc`);
}

function printBox(lines: string[]): void {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = '─'.repeat(width);
  process.stdout.write(`\n┌${bar}┐\n`);
  for (const line of lines) {
    process.stdout.write(`│  ${line.padEnd(width - 2)}│\n`);
  }
  process.stdout.write(`└${bar}┘\n\n`);
}

function reasonMessage(reason: VaultStatusReason): { title: string; body: string[]; canFix: boolean } {
  switch (reason) {
    case 'missing_file':
      return {
        title: 'No vault found',
        body: [
          'No secrets.enc file exists yet.',
          'This is normal on first run.',
          'Run `nimbus init` to set up your workspace.',
        ],
        canFix: false,
      };
    case 'missing_passphrase':
      return {
        title: 'Vault passphrase missing',
        body: [
          'The vault file exists but no passphrase was found.',
          'Set NIMBUS_VAULT_PASSPHRASE env var, or run `nimbus vault reset`.',
        ],
        canFix: true,
      };
    case 'decrypt_failed':
      return {
        title: 'Upgrade issue detected',
        body: [
          'Your API key vault was created by an older nimbus and cannot',
          'be decrypted by this version.',
          '',
          'Safe:     SOUL.md, MEMORY.md, sessions, workspace config',
          'Affected: API key (needs re-entry)',
        ],
        canFix: true,
      };
    case 'corrupt_envelope':
      return {
        title: 'Vault file corrupt',
        body: [
          'The vault file exists but cannot be parsed.',
          'It may have been corrupted or truncated.',
        ],
        canFix: true,
      };
    case 'schema_old':
      return {
        title: 'Vault schema outdated',
        body: [
          'The vault was written by an older version of nimbus.',
          'Re-entering your API key will migrate it to the current format.',
        ],
        canFix: true,
      };
    case 'schema_newer':
      return {
        title: 'Vault created by newer nimbus',
        body: [
          'The vault was written by a newer version of nimbus.',
          'Downgrade is not supported. Upgrade nimbus to continue.',
        ],
        canFix: false,
      };
  }
}

async function promptChoice(prompt: string, choices: string[], defaultIdx = 0): Promise<number> {
  process.stdout.write(`  ${prompt}\n\n`);
  choices.forEach((c, i) => process.stdout.write(`  [${i + 1}] ${c}\n`));
  process.stdout.write(`\n  Choice [${defaultIdx + 1}]: `);

  return await new Promise<number>((resolve) => {
    let buf = '';
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const cleanup = (): void => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.pause();
    };

    const onEnd = (): void => {
      // EOF / pipe closed — fall back to default choice gracefully
      cleanup();
      process.stdout.write('\n');
      resolve(defaultIdx);
    };

    const onData = (chunk: string): void => {
      // Handle Ctrl-C (SIGINT via raw byte 0x03 in raw mode, or SIGINT signal)
      if (chunk === '\x03') {
        cleanup();
        process.stdout.write('\n');
        resolve(defaultIdx);
        return;
      }
      buf += chunk;
      if (buf.includes('\n')) {
        cleanup();
        const trimmed = buf.trim();
        const n = parseInt(trimmed, 10);
        if (isNaN(n) || n < 1 || n > choices.length) {
          resolve(defaultIdx);
        } else {
          resolve(n - 1);
        }
        process.stdout.write('\n');
      }
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}

async function doVaultReset(): Promise<boolean> {
  process.stdout.write('  Backing up broken vault...\n');
  try {
    const backup = brokenBackupPath();
    await mkdir(nimbusHome(), { recursive: true });
    await copyFile(vaultPath(), backup);
    process.stdout.write(`  Backed up → ${backup}\n`);
  } catch {
    // vault may not exist — that's OK
  }

  try {
    await unlink(vaultPath());
  } catch {
    // already gone
  }

  process.stdout.write('  Re-provisioning vault passphrase...\n');
  const { autoProvisionPassphrase, __resetFileFallbackKey, __resetProvisionedPassphrase } =
    await import('../platform/secrets/fileFallback.ts');
  __resetProvisionedPassphrase();
  __resetFileFallbackKey();
  await autoProvisionPassphrase();

  // Re-prompt for API key
  const { getActiveWorkspace } = await import('../core/workspace.ts');
  const ws = await getActiveWorkspace();
  const provider = ws?.defaultProvider ?? 'anthropic';

  try {
    const { promptApiKey } = await import('./keyPrompt.ts');
    process.stdout.write(`\n  Re-enter your API key to restore access.\n`);
    const key = await promptApiKey({
      provider,
      prompt: `  ${provider} API key: `,
      input: process.stdin as NodeJS.ReadStream,
      output: process.stdout,
    });

    const { createKeyManager } = await import('../key/manager.ts');
    const wsId = ws?.id ?? 'personal';
    const km = createKeyManager();
    await km.set(provider, key, { wsId });
    process.stdout.write(`\n  Key stored. Verifying...\n`);

    try {
      const result = await km.test(provider, wsId);
      if (result.ok) {
        process.stdout.write(`  Vault restored. Ready.\n\n`);
      } else {
        process.stdout.write(`  Key stored (live test failed — check key or network).\n\n`);
      }
    } catch {
      process.stdout.write(`  Key stored (verification skipped — network may be offline).\n\n`);
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  Key re-entry failed: ${msg}\n  Run \`nimbus vault reset\` manually.\n\n`);
    return false;
  }
}

export interface RecoveryOpts {
  tty: boolean;
}

/**
 * runRecoveryPrompt — called at startup when diagnoseVault returns !ok.
 * Returns true if the issue was resolved and boot should continue.
 * Returns false if unresolvable (caller should exit 2).
 */
export async function runRecoveryPrompt(
  status: Extract<VaultStatus, { ok: false }>,
  opts: RecoveryOpts,
): Promise<boolean> {
  const { title, body, canFix } = reasonMessage(status.reason);

  // missing_file is benign — first run before init wizard, always allow boot.
  // BLOCKER 4: Return silently (no confusing "Run nimbus init" banner) — the
  // caller's fall-through to runAutoInit() handles first-run setup correctly.
  if (status.reason === 'missing_file') {
    process.stdout.write(`  No vault yet — starting setup...\n`);
    return true;
  }

  process.stdout.write(`\n  \u26a0  ${title}\n\n`);
  for (const line of body) {
    process.stdout.write(`  ${line}\n`);
  }
  process.stdout.write('\n');

  // Non-TTY: print and bail
  if (!opts.tty || !canFix) {
    if (!canFix) {
      process.stdout.write(`  Cannot auto-fix. See above for manual steps.\n`);
    } else {
      process.stdout.write(`  Non-interactive terminal. Run \`nimbus vault reset\` to fix.\n`);
    }
    return false;
  }

  printBox([`[1] Re-enter key now (recommended, ~10 sec)`, `[2] Skip (chat will not work until fixed)`]);

  const choice = await promptChoice('Choose an option:', ['Re-enter key now', 'Skip'], 0);

  if (choice === 0) {
    return await doVaultReset();
  }

  process.stdout.write('  Skipping vault recovery. Run `nimbus vault reset` when ready.\n\n');
  return true; // allow boot but chat will fail at provider level
}
