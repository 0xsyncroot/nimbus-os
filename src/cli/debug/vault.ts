// vault.ts — `nimbus debug vault` subcommand (SPEC-505)
// vault reset [--yes]   — backup + clear + re-provision + re-enter key
// vault status          — same as doctor's vault row
// Moved from src/cli/commands/vault.ts (SPEC-828).

import { chmod, copyFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { nimbusHome } from '../../platform/paths.ts';
import { diagnoseVault } from '../../platform/secrets/diagnose.ts';
import { detectProviderFromKey } from '../../onboard/keyValidators.ts';

const KNOWN_PROVIDERS = ['anthropic', 'openai', 'groq', 'deepseek', 'ollama'] as const;

/**
 * Resolve the concrete provider name (e.g. "openai", "groq") from available signals.
 * Priority: explicitFlag > detectedFromKey > error-with-hint
 *
 * workspace.defaultProvider stores a KIND ("openai-compat" | "anthropic"), not a provider name.
 * This helper converts that into a usable concrete name.
 */
function resolveProviderName(
  detectedFromKey: string | null,
  explicitFlag: string | null,
): string {
  if (explicitFlag) {
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(explicitFlag)) {
      throw new Error(
        `Unknown --provider "${explicitFlag}". Must be one of: ${KNOWN_PROVIDERS.join(', ')}`,
      );
    }
    return explicitFlag;
  }
  if (detectedFromKey) return detectedFromKey;
  throw new Error(
    `Cannot infer provider from key format. Pass --provider <${KNOWN_PROVIDERS.join('|')}>`,
  );
}

const VAULT_FILENAME = 'secrets.enc';

function vaultPath(): string {
  return join(nimbusHome(), VAULT_FILENAME);
}

function brokenBackupPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(nimbusHome(), `secrets.broken-${ts}.enc`);
}

async function runVaultReset(yes: boolean, keyStdin = false, providerFlag: string | null = null): Promise<number> {
  if (!yes) {
    process.stdout.write(
      [
        '',
        'This will:',
        '  1. Back up your current secrets.enc → secrets.broken-{ts}.enc',
        '  2. Delete the current vault',
        '  3. Re-provision the vault passphrase',
        '  4. Prompt you to re-enter your API key',
        '',
        'Run with --yes to confirm: nimbus debug vault reset --yes',
        'Pipe mode:  echo "sk-..." | nimbus debug vault reset --yes --key-stdin',
        '',
      ].join('\n'),
    );
    return 1;
  }

  process.stdout.write('\nnimbus vault reset\n');

  // 1. Snapshot existing vault
  try {
    const backup = brokenBackupPath();
    await mkdir(nimbusHome(), { recursive: true });
    await copyFile(vaultPath(), backup);
    // HARD RULE §6: vault-derived files MUST be 0o600 on POSIX; copyFile honors
    // umask which can leak 0o644 under user's default setting.
    if (process.platform !== 'win32') await chmod(backup, 0o600);
    process.stdout.write(`  Backed up → ${backup}\n`);
  } catch {
    process.stdout.write('  No existing vault to back up.\n');
  }

  // 2. Delete vault
  try {
    await unlink(vaultPath());
    process.stdout.write('  Existing vault cleared.\n');
  } catch {
    // already gone
  }

  // 3. Re-provision passphrase
  const { autoProvisionPassphrase, __resetFileFallbackKey, __resetProvisionedPassphrase } =
    await import('../../platform/secrets/fileFallback.ts');
  __resetProvisionedPassphrase();
  __resetFileFallbackKey();
  await autoProvisionPassphrase();
  process.stdout.write('  Passphrase re-provisioned.\n');

  // 4. Get active workspace (for wsId only — defaultProvider stores a KIND, not a name)
  const { getActiveWorkspace } = await import('../../core/workspace.ts');
  const ws = await getActiveWorkspace();
  const wsId = ws?.id ?? 'personal';

  // 5. Read API key — QA BUG fix: detect stdin-pipe mode
  // If --key-stdin flag is set OR stdin is not a TTY, read key from stdin pipe.
  // Otherwise use the interactive masked prompt (promptApiKey).
  const isNonTTY = !process.stdin.isTTY;
  const useStdin = keyStdin || isNonTTY;

  try {
    let key: string;

    if (useStdin) {
      process.stdout.write(`\n  Reading API key from stdin...\n`);
      const { readKeyFromStdin } = await import('../../onboard/keyPrompt.ts');
      key = await readKeyFromStdin(process.stdin as NodeJS.ReadStream);
    } else {
      // For interactive mode we need a concrete provider name for the prompt label.
      // Use --provider flag, else fall back to whatever was stored (may be a kind — OK for display only).
      const displayProvider = providerFlag ?? ws?.defaultProvider ?? 'anthropic';
      const { promptApiKey } = await import('../../onboard/keyPrompt.ts');
      process.stdout.write(`\n  Re-enter your API key.\n`);
      key = await promptApiKey({
        provider: displayProvider,
        prompt: `  ${displayProvider} API key: `,
        input: process.stdin as NodeJS.ReadStream,
        output: process.stdout,
      });
    }

    // 6. Resolve concrete provider name:
    //    Priority: --provider flag > auto-detect from key > error with hint
    const detected = detectProviderFromKey(key);
    const provider = resolveProviderName(detected?.provider ?? null, providerFlag);
    process.stdout.write(`  Provider: ${provider}\n`);

    const { createKeyManager } = await import('../../key/manager.ts');
    const km = createKeyManager();
    await km.set(provider, key, { wsId });
    process.stdout.write(`\n  Key stored. Verifying...\n`);

    try {
      const result = await km.test(provider, wsId);
      if (result.ok) {
        process.stdout.write(`  Vault reset complete. Chat should work now.\n\n`);
      } else {
        process.stdout.write(`  Key stored but live test failed. Check key or network.\n\n`);
      }
    } catch {
      process.stdout.write(`  Key stored (verification skipped).\n\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`  Key entry failed: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runVaultStatus(): Promise<number> {
  const status = await diagnoseVault();
  if (status.ok) {
    process.stdout.write(`Vault status: OK (schema v${status.schemaVersion})\n`);
    return 0;
  }
  process.stdout.write(`Vault status: FAIL — ${status.reason}\n`);
  if (status.details) {
    process.stdout.write(`  Details: ${JSON.stringify(status.details)}\n`);
  }
  return 1;
}

export async function runVault(subArgs: string[]): Promise<number> {
  const sub = subArgs[0];

  if (sub === 'reset') {
    const yes = subArgs.includes('--yes');
    const keyStdin = subArgs.includes('--key-stdin');
    // Parse --provider <name> (--provider=name form not needed for now)
    const providerIdx = subArgs.indexOf('--provider');
    const providerFlag = providerIdx !== -1 ? (subArgs[providerIdx + 1] ?? null) : null;
    return runVaultReset(yes, keyStdin, providerFlag);
  }

  if (sub === 'status') {
    return runVaultStatus();
  }

  process.stdout.write(
    [
      '',
      'nimbus debug vault — manage the encrypted secrets vault',
      '',
      'Usage:',
      '  nimbus debug vault reset [--yes]                           Backup + clear vault + re-enter API key',
      '  nimbus debug vault reset --yes --key-stdin                 Read key from stdin pipe (non-TTY)',
      '  nimbus debug vault reset --yes --key-stdin --provider <n>  Override provider (anthropic|openai|groq|deepseek|ollama)',
      '  nimbus debug vault status                                   Show vault health (same as nimbus debug doctor)',
      '',
      'Examples:',
      '  echo "sk-..." | nimbus debug vault reset --yes --key-stdin',
      '  echo "sk-..." | nimbus debug vault reset --yes --key-stdin --provider openai',
      '',
    ].join('\n'),
  );
  return 0;
}
