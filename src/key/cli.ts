// cli.ts — SPEC-902 T7: argv parser for `nimbus key <subcmd>`.

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { createKeyManager, type KeyManager } from './manager.ts';
import { promptApiKey, readKeyFromStdin } from '../onboard/keyPrompt.ts';

interface KeyCliOpts {
  argv: string[];
  manager?: KeyManager;
  output?: NodeJS.WritableStream;
  input?: NodeJS.ReadStream;
}

export async function runKeyCli(opts: KeyCliOpts): Promise<number> {
  const manager = opts.manager ?? createKeyManager();
  const output = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;
  const [subcmd, ...rest] = opts.argv;

  switch (subcmd) {
    case 'set':
      return handleSet(manager, rest, input, output);
    case 'list':
    case 'ls':
      return handleList(manager, output);
    case 'delete':
    case 'rm':
      return handleDelete(manager, rest, output);
    case 'test':
      return handleTest(manager, rest, output);
    default:
      throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
        reason: 'unknown_key_subcommand',
        subcmd: subcmd ?? '(none)',
        hint: 'usage: nimbus key <set|list|delete|test> [provider]',
      });
  }
}

interface SetFlags {
  provider?: string;
  baseUrl?: string;
  keyStdin: boolean;
  keyFromEnv?: string;
  skipTest: boolean;
  liveTest: boolean;
}

function parseSetFlags(args: string[]): SetFlags {
  const flags: SetFlags = { keyStdin: false, skipTest: false, liveTest: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      if (a === '--key-stdin') flags.keyStdin = true;
      else if (a === '--skip-test') flags.skipTest = true;
      else if (a === '--test') flags.liveTest = true;
      else if (a === '--base-url') flags.baseUrl = args[++i];
      else if (a.startsWith('--base-url=')) flags.baseUrl = a.slice('--base-url='.length);
      else if (a === '--key-from-env') flags.keyFromEnv = args[++i];
      else if (a.startsWith('--key-from-env=')) flags.keyFromEnv = a.slice('--key-from-env='.length);
      else {
        throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'unknown_flag', flag: a });
      }
    } else if (!flags.provider) {
      flags.provider = a;
    }
  }
  return flags;
}

async function handleSet(
  manager: KeyManager,
  args: string[],
  input: NodeJS.ReadStream,
  output: NodeJS.WritableStream,
): Promise<number> {
  const flags = parseSetFlags(args);
  if (!flags.provider) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'missing_provider',
      hint: 'nimbus key set <anthropic|openai|groq|deepseek|ollama>',
    });
  }

  let key: string;
  if (flags.keyFromEnv) {
    const v = process.env[flags.keyFromEnv];
    if (!v) {
      throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
        reason: 'env_var_empty',
        envVar: flags.keyFromEnv,
      });
    }
    key = v;
  } else if (flags.keyStdin || process.env['NIMBUS_API_KEY_STDIN'] === '1') {
    key = await readKeyFromStdin(input);
  } else {
    key = await promptApiKey({ provider: flags.provider, input, output });
  }

  const setOpts: { baseUrl?: string; liveTest?: boolean } = {};
  if (flags.baseUrl) setOpts.baseUrl = flags.baseUrl;
  if (flags.liveTest && !flags.skipTest) setOpts.liveTest = true;
  await manager.set(flags.provider, key, setOpts);
  output.write(`  stored ${flags.provider} key\n`);

  // SPEC-902 bugfix #5: align workspace.json when baseUrl is set for the active provider.
  // Without this, REPL boot reads workspace.json (which has no baseUrl) and never reaches
  // the secret store sidecar, so `key set --base-url` silently wouldn't take effect at runtime.
  if (flags.baseUrl) {
    await alignWorkspaceBaseUrl(flags.provider, flags.baseUrl, output);
  } else {
    // Always align workspace provider kind even when no --base-url is given.
    // e.g. `nimbus key set openai` (no --base-url) should flip defaultProvider to openai-compat.
    await alignWorkspaceProvider(flags.provider, output);
  }
  return 0;
}

function workspaceKindFor(provider: string): 'anthropic' | 'openai-compat' {
  // anthropic stays anthropic; everything else (openai/groq/deepseek/ollama) is openai-compat.
  return provider === 'anthropic' ? 'anthropic' : 'openai-compat';
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
  deepseek: 'deepseek-chat',
  ollama: 'llama3.2',
};

/**
 * Always-run after `key set` (no --base-url path).
 * Flips defaultProvider and defaultModel in workspace.json when the stored provider
 * kind differs from what is already configured.  Idempotent — no write when already aligned.
 */
async function alignWorkspaceProvider(
  provider: string,
  output: NodeJS.WritableStream,
): Promise<void> {
  const { getActiveWorkspace } = await import('../core/workspace.ts');
  const { updateWorkspace } = await import('../storage/workspaceStore.ts');
  const active = await getActiveWorkspace();
  if (!active) return;

  const targetKind = workspaceKindFor(provider);
  if (active.defaultProvider === targetKind) return; // already aligned — no-op

  const prevKind = active.defaultProvider;
  const targetModel = DEFAULT_MODELS[provider] ?? active.defaultModel;

  output.write(
    `  → workspace provider: ${prevKind} → ${targetKind}\n`,
  );

  await updateWorkspace(active.id, {
    defaultProvider: targetKind,
    defaultModel: targetModel,
  });
}

async function alignWorkspaceBaseUrl(
  provider: string,
  baseUrl: string,
  output: NodeJS.WritableStream,
): Promise<void> {
  const { getActiveWorkspace } = await import('../core/workspace.ts');
  const { updateWorkspace } = await import('../storage/workspaceStore.ts');
  const active = await getActiveWorkspace();
  if (!active) return;

  // Bugfix #6 — explicit --base-url is unambiguous user intent. Always align workspace,
  // crossing kinds if needed (anthropic ↔ openai-compat). The cross-kind safety from #40
  // is dropped: a stale silent skip is worse than a clear "switching" notice.
  const targetKind = workspaceKindFor(provider);
  const targetEndpoint: 'custom' = 'custom';
  const kindSwitch = active.defaultProvider !== targetKind;

  // Idempotent no-op when nothing would change.
  if (
    !kindSwitch &&
    active.defaultBaseUrl === baseUrl &&
    (provider === 'anthropic' || active.defaultEndpoint === targetEndpoint)
  ) {
    return;
  }

  const patch: {
    defaultBaseUrl: string;
    defaultEndpoint?: 'custom';
    defaultProvider?: 'anthropic' | 'openai-compat';
  } = { defaultBaseUrl: baseUrl };
  if (provider !== 'anthropic') patch.defaultEndpoint = targetEndpoint;
  if (kindSwitch) patch.defaultProvider = targetKind;

  // Print switch notice BEFORE the write so the user sees intent → action in order.
  if (kindSwitch) {
    output.write(
      `  → switching workspace "${active.name}" provider: ${active.defaultProvider} → ${targetKind} (per --base-url)\n`,
    );
  }

  await updateWorkspace(active.id, patch);

  output.write(`  workspace "${active.name}" aligned: baseUrl=${baseUrl}\n`);
}

async function handleList(
  manager: KeyManager,
  output: NodeJS.WritableStream,
): Promise<number> {
  const entries = await manager.list();
  if (entries.length === 0) {
    output.write('  no keys configured\n');
    return 0;
  }
  for (const e of entries) {
    const date = e.createdAt ? new Date(e.createdAt).toISOString().slice(0, 10) : '—';
    output.write(`  ${e.provider.padEnd(10)} ${e.masked.padEnd(20)} ${date}\n`);
  }
  return 0;
}

async function handleDelete(
  manager: KeyManager,
  args: string[],
  output: NodeJS.WritableStream,
): Promise<number> {
  let provider: string | undefined;
  let yes = false;
  for (const a of args) {
    if (a === '--yes' || a === '-y') yes = true;
    else if (!a.startsWith('--')) provider = a;
  }
  if (!provider) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'missing_provider' });
  }
  if (!yes) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'confirmation_required',
      hint: 'add --yes to confirm key deletion',
    });
  }
  await manager.delete(provider);
  output.write(`  deleted ${provider} key\n`);
  return 0;
}

async function handleTest(
  manager: KeyManager,
  args: string[],
  output: NodeJS.WritableStream,
): Promise<number> {
  const provider = args.find((a) => !a.startsWith('--'));
  if (!provider) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'missing_provider' });
  }
  const result = await manager.test(provider);
  if (result.ok) {
    output.write(`  ${provider}: OK (${result.latencyMs}ms, ~$${result.costUsd.toFixed(5)})\n`);
    return 0;
  }
  output.write(`  ${provider}: FAIL (${result.errorCode ?? 'unknown'}, ${result.latencyMs}ms)\n`);
  return 2;
}
