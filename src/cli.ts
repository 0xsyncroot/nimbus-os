#!/usr/bin/env bun
// cli.ts — nimbus CLI entry point (user-facing AI OS commands)
// Routes: `nimbus init` → onboard wizard; `nimbus` → REPL; `nimbus cost`/`--version`/`--help` → static.

import { NimbusError } from './observability/errors.ts';
import { logger } from './observability/logger.ts';
import { printError } from './observability/errorFormat.ts';

const args = process.argv.slice(2);
const cmd = args[0];

interface ParsedFlags {
  force: boolean;
  noPrompt: boolean;
  noChat: boolean;
  advanced: boolean;
  name?: string;
  location?: string;
  skipPermissions: boolean;
  skipKey: boolean;
  verbose: boolean;
  provider?: string;
  endpoint?: string;
  baseUrl?: string;
}

function parseFlags(rest: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    force: false,
    noPrompt: false,
    noChat: false,
    advanced: false,
    skipPermissions: false,
    skipKey: false,
    verbose: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--force') flags.force = true;
    else if (a === '--no-prompt') flags.noPrompt = true;
    else if (a === '--no-chat') flags.noChat = true;
    else if (a === '--advanced') flags.advanced = true;
    else if (a === '--verbose' || a === '-V') flags.verbose = true;
    else if (a === '--dangerously-skip-permissions') flags.skipPermissions = true;
    else if (a === '--skip-key') flags.skipKey = true;
    else if (a === '--name') flags.name = rest[++i];
    else if (a === '--location') flags.location = rest[++i];
    else if (a === '--provider') flags.provider = rest[++i];
    else if (a === '--endpoint') flags.endpoint = rest[++i];
    else if (a === '--base-url') flags.baseUrl = rest[++i];
    else if (a.startsWith('--name=')) flags.name = a.slice('--name='.length);
    else if (a.startsWith('--location=')) flags.location = a.slice('--location='.length);
    else if (a.startsWith('--provider=')) flags.provider = a.slice('--provider='.length);
    else if (a.startsWith('--endpoint=')) flags.endpoint = a.slice('--endpoint='.length);
    else if (a.startsWith('--base-url=')) flags.baseUrl = a.slice('--base-url='.length);
  }
  return flags;
}

/**
 * runAutoInit — called when `nimbus` is run for the first time with no workspace.
 * 1. Check env vars (ANTHROPIC_API_KEY / OPENAI_API_KEY / GROQ_API_KEY)
 * 2. If found → auto-create "personal" workspace with detected provider
 * 3. If not found → prompt "Paste your API key:" → detect provider → create workspace
 */
async function runAutoInit(): Promise<void> {
  const { detectEnvKey, quickInit } = await import('./onboard/init.ts');
  const { detectProviderFromKey } = await import('./onboard/keyValidators.ts');
  const { promptApiKey, readKeyFromStdin } = await import('./onboard/keyPrompt.ts');

  const envFound = detectEnvKey();
  if (envFound) {
    const detected = detectProviderFromKey(envFound.key);
    if (detected) {
      process.stdout.write(`  Found ${detected.provider} key (${ envFound.envVar}). Setting up workspace...\n`);
      await quickInit(
        { provider: detected.provider, defaultModel: detected.defaultModel, kind: detected.kind, defaultEndpoint: detected.defaultEndpoint, defaultBaseUrl: detected.defaultBaseUrl },
        envFound.key,
      );
      process.stdout.write(`  Ready. Workspace "personal" created.\n\n`);
      return;
    }
  }

  // No env key found or couldn't detect → prompt user
  process.stdout.write(`\n  Welcome to nimbus!\n  No workspace found.\n\n`);
  const isTTY = process.stdin.isTTY;
  let key: string | undefined;
  let detectedProvider;

  if (isTTY) {
    try {
      // Use promptApiKey on TTY — it resolves on \r/\n properly.
      // BUG v0.2.3: readKeyFromStdin was used here; it only resolves on stdin 'end',
      // which a TTY never emits → CLI hung forever after paste.
      key = await promptApiKey({
        provider: 'detected',
        prompt: '  Paste your API key (Anthropic, OpenAI, or Groq): ',
        input: process.stdin as NodeJS.ReadStream,
      });
    } catch (err) {
      const { logger } = await import('./observability/logger.ts');
      logger.debug({ err: (err as Error).message }, 'auto_init_prompt_failed');
    }
  } else {
    try {
      key = await readKeyFromStdin(process.stdin as NodeJS.ReadStream);
    } catch {
      // piped empty stdin — fall through
    }
  }

  if (key) {
    detectedProvider = detectProviderFromKey(key);
  }

  if (!key || !detectedProvider) {
    process.stderr.write(
      `  Could not detect provider from key. Run \`nimbus init\` for full setup.\n`,
    );
    // Fall through — init without a key so user gets REPL and can configure later.
    // Use anthropic as default to not break startup.
    detectedProvider = { provider: 'anthropic', kind: 'anthropic' as const, defaultModel: 'claude-sonnet-4-6' };
    key = undefined;
  }

  await quickInit(
    { provider: detectedProvider.provider, defaultModel: detectedProvider.defaultModel, kind: detectedProvider.kind, defaultEndpoint: detectedProvider.defaultEndpoint, defaultBaseUrl: detectedProvider.defaultBaseUrl },
    key,
  );
  process.stdout.write(`  Ready. Workspace "personal" created.\n\n`);
}

async function main(): Promise<number> {
  switch (cmd) {
    case '--version':
    case '-v':
      process.stdout.write('nimbus-os 0.3.6-alpha\n');
      return 0;
    case '--help':
    case '-h':
      printHelp();
      return 0;
    case 'init': {
      const { runInit } = await import('./onboard/init.ts');
      const flags = parseFlags(args.slice(1));
      const opts: Parameters<typeof runInit>[0] = {
        force: flags.force,
        noPrompt: flags.noPrompt,
        advanced: flags.advanced,
        skipKeyStep: flags.skipKey,
      };
      if (flags.location !== undefined) opts.location = flags.location;
      const answers: Record<string, unknown> = {};
      if (flags.name !== undefined) answers['workspaceName'] = flags.name;
      if (flags.provider !== undefined) answers['provider'] = flags.provider;
      if (flags.endpoint !== undefined) answers['endpoint'] = flags.endpoint;
      if (flags.baseUrl !== undefined) answers['baseUrl'] = flags.baseUrl;
      if (Object.keys(answers).length > 0) {
        opts.answers = answers as NonNullable<Parameters<typeof runInit>[0]>['answers'];
      }
      await runInit(opts);
      if (flags.noChat || flags.noPrompt) return 0; // CI / scripted path — skip auto-REPL
      // Auto-continue into interactive REPL so the user doesn't have to re-run `nimbus`.
      const { startRepl } = await import('./channels/cli/repl.ts');
      await startRepl({ skipPermissions: flags.skipPermissions });
      return 0;
    }
    case 'cost': {
      const { runCost } = await import('./cli/commands/cost.ts');
      return runCost(args.slice(1));
    }
    case 'key': {
      const { runKeyCli } = await import('./key/index.ts');
      return runKeyCli({ argv: args.slice(1) });
    }
    case 'doctor': {
      const { runDoctor } = await import('./cli/commands/doctor.ts');
      return runDoctor();
    }
    case 'vault': {
      const { runVault } = await import('./cli/commands/vault.ts');
      return runVault(args.slice(1));
    }
    case 'backup': {
      const { runBackup } = await import('./cli/commands/backup.ts');
      return runBackup(args.slice(1));
    }
    case 'status': {
      const { runStatus } = await import('./cli/commands/status.ts');
      return runStatus(args.slice(1));
    }
    case 'health': {
      const { runHealth } = await import('./cli/commands/health.ts');
      return runHealth(args.slice(1));
    }
    case 'metrics': {
      const { runMetrics } = await import('./cli/commands/metrics.ts');
      return runMetrics(args.slice(1));
    }
    case 'errors': {
      const { runErrors } = await import('./cli/commands/errors.ts');
      return runErrors(args.slice(1));
    }
    case 'trace': {
      const { runTrace } = await import('./cli/commands/trace.ts');
      return runTrace(args.slice(1));
    }
    case 'audit': {
      const { runAudit } = await import('./cli/commands/audit.ts');
      return runAudit(args.slice(1));
    }
    case 'skill': {
      const { runSkillCli } = await import('./skills/registry/skillCli.ts');
      return runSkillCli(args.slice(1));
    }
    case 'telegram': {
      const { runTelegram } = await import('./cli/commands/telegram.ts');
      return runTelegram(args.slice(1));
    }
    case undefined: {
      // Detect upgrade banner
      if (!process.env['NIMBUS_SKIP_UPGRADE_DETECT']) {
        const { readInstalledVersion, writeInstalledVersion, printUpgradeNote } =
          await import('./onboard/upgradeDetector.ts');
        const current = '0.3.6-alpha';
        const installed = await readInstalledVersion();
        if (installed && installed !== current) {
          process.stdout.write(`nimbus ${installed} → ${current} (upgraded)\n`);
          await printUpgradeNote(installed, current);
        }
        await writeInstalledVersion(current);
      }

      // Auto-detect vault issues before boot
      if (!process.env['NIMBUS_SKIP_DIAGNOSE']) {
        const { diagnoseVault } = await import('./platform/secrets/diagnose.ts');
        const vaultStatus = await diagnoseVault();
        if (!vaultStatus.ok && vaultStatus.reason !== 'missing_file') {
          const { runRecoveryPrompt } = await import('./onboard/recoveryPrompt.ts');
          const handled = await runRecoveryPrompt(vaultStatus, { tty: process.stdin.isTTY });
          if (!handled) return 2;
        }
      }

      const { getActiveWorkspace } = await import('./core/workspace.ts');
      const active = await getActiveWorkspace();
      if (!active) {
        // Auto-init: no workspace exists → check env vars or prompt for key
        await runAutoInit();
      }
      const { startRepl } = await import('./channels/cli/repl.ts');
      const flags = parseFlags(args);
      await startRepl({ skipPermissions: flags.skipPermissions });
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  process.stdout.write(`nimbus — AI OS

Usage: nimbus [command] [args]

Commands:
  (default)  Enter interactive AI OS session in active workspace
             Flags: --dangerously-skip-permissions (requires NIMBUS_BYPASS_CONFIRMED=1)
  init       Onboarding wizard — create first workspace + SOUL.md, then enters REPL
             Flags: --name <name>  --location <dir>  --force  --no-prompt  --no-chat
  key        Manage provider API keys (set/list/delete/test)
             Flags: --key-stdin  --key-from-env <VAR>  --base-url <url>  --test  --skip-test  --yes
  doctor     Health check — platform, vault, permissions (exit 0=OK, 1=issues)
  vault      Manage encrypted secrets vault
             Subcommands: reset [--yes]  status
  backup     Workspace backup and restore
             Subcommands: create [--out FILE]  restore <file>  list
  cost       View token + USD usage (v0.2)
  status     1-line overview: OK | last error | today cost
  health     Subsystem health + memory + disk  [--json]
  metrics    p50/p95/p99 + tokens + cost       [--since 1h|1d] [--json]
  errors     Error counts by code              [--since] [--code X_*] [--json]
  trace      Turn event tree                   <turnId> [--json]
  audit      Security events + exec/write log  [--since] [--severity] [--json]
  skill      Manage skills from the registry
             Subcommands: search [query]  install <name[@ver]>  list  info <name>
                          upgrade <name>  revoke <name>  reassess <name>  audit
  telegram   Configure built-in Telegram channel (token + allowlist)
             Subcommands: set-token  allow <id>  remove <id>  list  status
                          test  clear-token  reset --yes
             Tip: connect to Telegram from the REPL — say "kết nối telegram"

Future versions:
  daemon     Install/manage background service (v0.4)

Run \`nimbus <command> --help\` for command details.
`);
}

const globalVerbose = args.includes('--verbose') || args.includes('-V');

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof NimbusError) {
      printError(err, globalVerbose);
      // Also emit debug JSON to logger for structured log consumers.
      logger.debug({ err: err.toJSON() }, 'nimbus_error');
      process.exit(2);
    }
    logger.error({ err: (err as Error).message, stack: (err as Error).stack }, 'fatal');
    process.stderr.write(`Fatal: ${(err as Error).message}\n`);
    process.exit(3);
  });
