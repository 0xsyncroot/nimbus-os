#!/usr/bin/env bun
// cli.ts — nimbus CLI entry point (user-facing AI OS commands)
// Routes: `nimbus init` → onboard wizard; `nimbus` → REPL; `nimbus cost`/`--version`/`--help` → static.

import { ErrorCode, NimbusError } from './observability/errors.ts';
import { logger } from './observability/logger.ts';

const args = process.argv.slice(2);
const cmd = args[0];

interface ParsedFlags {
  force: boolean;
  noPrompt: boolean;
  name?: string;
  location?: string;
  skipPermissions: boolean;
  skipKey: boolean;
  provider?: string;
  endpoint?: string;
  baseUrl?: string;
}

function parseFlags(rest: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    force: false,
    noPrompt: false,
    skipPermissions: false,
    skipKey: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--force') flags.force = true;
    else if (a === '--no-prompt') flags.noPrompt = true;
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

async function main(): Promise<number> {
  switch (cmd) {
    case '--version':
    case '-v':
      process.stdout.write('nimbus-os 0.1.0-dev\n');
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
      return 0;
    }
    case 'cost':
      process.stdout.write('cost tracking arrives in v0.2\n');
      return 0;
    case 'key': {
      const { runKeyCli } = await import('./key/index.ts');
      return runKeyCli({ argv: args.slice(1) });
    }
    case undefined: {
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

Commands (v0.1 MVP):
  (default)  Enter interactive AI OS session in active workspace
             Flags: --dangerously-skip-permissions (requires NIMBUS_BYPASS_CONFIRMED=1)
  init       Onboarding wizard — create first workspace + SOUL.md
             Flags: --name <name>  --location <dir>  --force  --no-prompt
  key        Manage provider API keys (set/list/delete/test)
             Flags: --key-stdin  --key-from-env <VAR>  --base-url <url>  --test  --skip-test  --yes
  cost       View token + USD usage (v0.2)

Future versions:
  status     System status overview (v0.3)
  daemon     Install/manage background service (v0.4)

Run \`nimbus <command> --help\` for command details.
`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof NimbusError) {
      process.stderr.write(`[ERROR] ${err.code}: ${JSON.stringify(err.context)}\n`);
      if (err.code === ErrorCode.U_MISSING_CONFIG && err.context['reason'] === 'no_active_workspace') {
        process.stderr.write(`\nHint: run \`nimbus init\` to create your first workspace.\n`);
      }
      process.exit(2);
    }
    logger.error({ err: (err as Error).message, stack: (err as Error).stack }, 'fatal');
    process.stderr.write(`Fatal: ${(err as Error).message}\n`);
    process.exit(3);
  });
