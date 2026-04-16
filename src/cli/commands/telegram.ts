// telegram.ts — SPEC-808 T5: `nimbus telegram` subcommand.
// Manages bot token + user allowlist in the vault. Does NOT start the adapter —
// that happens inside the REPL via the ConnectTelegram tool (daemon deferred to v0.4).

import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { readKeyFromStdin, promptApiKey } from '../../onboard/keyPrompt.ts';
import { autoProvisionPassphrase } from '../../platform/secrets/fileFallback.ts';
import {
  addAllowedUserId,
  clearAllTelegramConfig,
  clearTelegramBotToken,
  getAllowedUserIds,
  getTelegramBotToken,
  readSummary,
  removeAllowedUserId,
  setTelegramBotToken,
} from '../../channels/telegram/config.ts';

export async function runTelegram(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'set-token':
      return handleSetToken(rest);
    case 'clear-token':
      return handleClearToken();
    case 'allow':
      return handleAllow(rest);
    case 'deny':
    case 'remove':
      return handleRemove(rest);
    case 'list':
      return handleList();
    case 'status':
      return handleStatus();
    case 'test':
      return handleTest();
    case 'reset':
      return handleReset(rest);
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`Unknown telegram subcommand: ${sub}\n`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  process.stdout.write(`nimbus telegram — manage the built-in Telegram channel

Usage: nimbus telegram <subcommand>

Subcommands:
  set-token            Store bot token (prompts masked; or pipe via stdin)
                       Flags: --token-stdin   Read token from stdin (for scripts)
  clear-token          Remove bot token from the vault
  allow <userId>       Authorise a Telegram numeric user id
  remove <userId>      Revoke a previously authorised user id (alias: deny)
  list                 Show authorised user ids
  status               Show token presence + allowlist + online state (offline if REPL not running)
  test                 Call Telegram getMe to validate the stored token (reports @username)
  reset                Wipe all Telegram config (token + allowlist) — requires --yes

Notes:
  The adapter runs inside the REPL process (v0.3.6). From the REPL, say
  "kết nối telegram" or ask the agent to connect — it will invoke the
  ConnectTelegram tool. Daemon mode (24/7) is planned for v0.4.

  Get your bot token from @BotFather. Your Telegram numeric user id is
  visible via @userinfobot.
`);
}

async function handleSetToken(args: string[]): Promise<number> {
  await autoProvisionPassphrase({ input: process.stdin, output: process.stdout });

  let useStdin = false;
  for (const a of args) {
    if (a === '--token-stdin' || a === '--stdin') useStdin = true;
    else if (a === '--help') {
      process.stdout.write('nimbus telegram set-token [--token-stdin]\n');
      return 0;
    } else {
      throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'unknown_flag', flag: a });
    }
  }

  let token: string;
  if (useStdin || process.env['NIMBUS_API_KEY_STDIN'] === '1') {
    token = await readKeyFromStdin(process.stdin);
  } else {
    token = await promptApiKey({
      provider: 'telegram',
      prompt: 'Paste Telegram bot token from @BotFather: ',
      input: process.stdin,
      output: process.stdout,
    });
  }

  await setTelegramBotToken(token);
  process.stdout.write('  stored Telegram bot token\n');
  return 0;
}

async function handleClearToken(): Promise<number> {
  await autoProvisionPassphrase({ input: process.stdin, output: process.stdout });
  await clearTelegramBotToken();
  process.stdout.write('  cleared Telegram bot token\n');
  return 0;
}

function parseUserId(raw: string | undefined): number {
  if (!raw) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'missing_user_id',
      hint: 'usage: nimbus telegram allow <userId>',
    });
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'invalid_user_id',
      given: raw,
      hint: 'expected positive integer (get via @userinfobot)',
    });
  }
  return n;
}

async function handleAllow(args: string[]): Promise<number> {
  await autoProvisionPassphrase({ input: process.stdin, output: process.stdout });
  const id = parseUserId(args[0]);
  await addAllowedUserId(id);
  process.stdout.write(`  authorised user ${id}\n`);
  return 0;
}

async function handleRemove(args: string[]): Promise<number> {
  await autoProvisionPassphrase({ input: process.stdin, output: process.stdout });
  const id = parseUserId(args[0]);
  await removeAllowedUserId(id);
  process.stdout.write(`  removed user ${id}\n`);
  return 0;
}

async function handleList(): Promise<number> {
  await autoProvisionPassphrase({ input: process.stdin, output: process.stdout });
  const allowed = await getAllowedUserIds();
  if (allowed.length === 0) {
    process.stdout.write('  no authorised users\n');
    return 0;
  }
  for (const id of allowed) process.stdout.write(`  ${id}\n`);
  return 0;
}

async function handleStatus(): Promise<number> {
  await autoProvisionPassphrase({ input: process.stdin, output: process.stdout });
  const summary = await readSummary();
  const lines: string[] = [];
  lines.push(`  token:   ${summary.tokenPresent ? 'present' : 'not set'}`);
  lines.push(`  allowed: ${summary.allowedUserIds.length} user(s)`);
  if (summary.allowedUserIds.length > 0) {
    lines.push(`           ${summary.allowedUserIds.join(', ')}`);
  }
  lines.push('  state:   offline (adapter runs inside REPL; daemon = v0.4)');
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

async function handleTest(): Promise<number> {
  await autoProvisionPassphrase({ input: process.stdin, output: process.stdout });
  const token = await getTelegramBotToken();
  if (!token) {
    process.stderr.write('  no token stored — run `nimbus telegram set-token` first\n');
    return 2;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (!resp.ok) {
      process.stderr.write(`  getMe HTTP ${resp.status}\n`);
      return 2;
    }
    const body = (await resp.json()) as {
      ok: boolean;
      result?: { username?: string; first_name?: string; id?: number };
      description?: string;
    };
    if (!body.ok || !body.result) {
      process.stderr.write(`  getMe failed: ${body.description ?? 'unknown error'}\n`);
      return 2;
    }
    const name = body.result.username ?? body.result.first_name ?? 'bot';
    process.stdout.write(`  OK — @${name} (id=${body.result.id ?? '?'})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`  getMe error: ${(err as Error).message}\n`);
    return 2;
  }
}

async function handleReset(args: string[]): Promise<number> {
  const yes = args.includes('--yes') || args.includes('-y');
  if (!yes) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'confirmation_required',
      hint: 'add --yes to wipe all Telegram config',
    });
  }
  await autoProvisionPassphrase({ input: process.stdin, output: process.stdout });
  await clearAllTelegramConfig();
  process.stdout.write('  Telegram config cleared\n');
  return 0;
}
