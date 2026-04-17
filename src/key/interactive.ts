// interactive.ts — SPEC-904: unified interactive key manager.
// Called by: `nimbus key` (no sub-cmd), `/key` slash, boot recovery (SPEC-505).
// HARD RULES (enforced here):
//   - Never touch .vault-key passphrase (write is for keys only)
//   - Probe-before-write via autoProvisionPassphrase canDecryptVault semantics
//   - Atomic write via KeyManager.set (SPEC-153)
//   - Never log key plaintext; masked form only in output

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { autoProvisionPassphrase } from '../platform/secrets/fileFallback.ts';
import { createKeyManager, maskKey, type KeyListEntry } from './manager.ts';
import { promptApiKey } from '../onboard/keyPrompt.ts';
import { detectProviderFromKey } from '../onboard/keyValidators.ts';
import { pickOne, type PickerItem } from '../onboard/picker.ts';
import { logger } from '../observability/logger.ts';

const KNOWN_PROVIDERS = ['openai', 'anthropic', 'groq', 'gemini', 'deepseek', 'ollama'] as const;
type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

export interface KeyManagerContext {
  workspaceId: string;
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (r: boolean) => unknown };
  output: NodeJS.WritableStream;
  isTTY: boolean;
}

/** Run the interactive key manager menu loop. Returns exit code. */
export async function runInteractiveKeyManager(ctx: KeyManagerContext): Promise<number> {
  if (!ctx.isTTY) {
    ctx.output.write(
      [
        '  nimbus key: interactive mode requires a TTY.',
        '  Use non-interactive form instead:',
        '    echo "sk-..." | nimbus key set openai --key-stdin',
        '    nimbus key set openai --key-from-env MY_KEY_VAR',
        '',
      ].join('\n'),
    );
    return 1;
  }

  // Provision passphrase — catches vault_locked before any write.
  try {
    await autoProvisionPassphrase({ input: ctx.input, output: ctx.output });
  } catch (err) {
    if (err instanceof NimbusError && err.code === ErrorCode.X_CRED_ACCESS) {
      ctx.output.write(
        [
          '',
          '  Vault is locked — cannot open key manager.',
          `  Hint: ${(err.context as Record<string, unknown>)['hint'] ?? 'run `nimbus vault reset` to recover'}`,
          '',
        ].join('\n'),
      );
      return 2;
    }
    throw err;
  }

  const manager = createKeyManager();

  // Refresh list once; we do NOT loop back after a successful action (Bug C fix).
  const entries = await manager.list(ctx.workspaceId || undefined);
  const choice = await renderMenu(ctx, entries);

  if (choice === 'cancel') return 0;

  if (choice === 'add') {
    await addKeyFlow(ctx, manager);
    return 0;
  }

  // Existing provider action.
  const { provider, entry } = choice;
  const action = entry
    ? await renderSubMenu(ctx, provider)
    : 'replace'; // empty slot → go straight to paste

  if (action === 'cancel') return 0;

  if (action === 'replace') {
    await changeKeyFlow(ctx, provider, manager);
  } else if (action === 'test') {
    await testFlow(ctx, provider, manager);
  } else if (action === 'remove') {
    await removeFlow(ctx, provider, manager);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Menu rendering helpers
// ---------------------------------------------------------------------------

type MenuChoice =
  | 'cancel'
  | 'add'
  | { provider: string; entry: KeyListEntry | undefined };

async function renderMenu(ctx: KeyManagerContext, entries: KeyListEntry[]): Promise<MenuChoice> {
  const slots = KNOWN_PROVIDERS.map((p): { provider: string; entry: KeyListEntry | undefined } => ({
    provider: p,
    entry: entries.find((e) => e.provider === p),
  }));

  type MenuValue = 'cancel' | 'add' | { provider: string; entry: KeyListEntry | undefined };

  const items: PickerItem<MenuValue>[] = [
    ...slots.map((slot): PickerItem<MenuValue> => {
      const hint = slot.entry
        ? `${slot.entry.masked.padEnd(14)} ${formatAge(slot.entry.createdAt)}`
        : '(not set)';
      return { value: slot, label: slot.provider.padEnd(12), hint };
    }),
    { value: 'add' as MenuValue, label: 'Add new key…' },
    { value: 'cancel' as MenuValue, label: 'Cancel' },
  ];

  // Default cursor on first empty slot (or Cancel if all set).
  const firstEmpty = slots.findIndex((s) => !s.entry);
  const defaultIdx = firstEmpty >= 0 ? firstEmpty : items.length - 1;

  const io = { input: ctx.input, output: ctx.output };
  const picked = await pickOne<MenuValue>('API keys', items, { default: defaultIdx }, io);

  if (picked === 'skip' || typeof picked === 'object' && 'custom' in picked) return 'cancel';
  return picked as MenuChoice;
}

type SubAction = 'replace' | 'test' | 'remove' | 'cancel';

async function renderSubMenu(ctx: KeyManagerContext, provider: string): Promise<SubAction> {
  const items: PickerItem<SubAction>[] = [
    { value: 'replace', label: 'Replace key', hint: 'paste a new key' },
    { value: 'test',    label: 'Test key',    hint: 'verify it works' },
    { value: 'remove',  label: 'Delete key',  hint: 'removes from vault' },
    { value: 'cancel',  label: 'Cancel' },
  ];
  const io = { input: ctx.input, output: ctx.output };
  const picked = await pickOne<SubAction>(
    `${provider}: what to do?`,
    items,
    { default: 0, shortcuts: { r: 0, t: 1, d: 2, c: 3 } },
    io,
  );
  if (picked === 'skip' || typeof picked === 'object') return 'cancel';
  return picked as SubAction;
}

// ---------------------------------------------------------------------------
// Exported flow functions
// ---------------------------------------------------------------------------

/** Replace (or set) a key for a specific provider. Probe-before-write enforced. */
export async function changeKeyFlow(
  ctx: KeyManagerContext,
  provider: string,
  managerOverride?: ReturnType<typeof createKeyManager>,
): Promise<void> {
  const manager = managerOverride ?? createKeyManager();

  const input = ctx.input as NodeJS.ReadStream;
  const key = await promptApiKey({
    provider,
    prompt: `  ${provider} API key (masked): `,
    input,
    output: ctx.output,
    clearOnExit: true,
  });

  // Live-test before writing — catches typos / revoked keys.
  // runLiveTestForKey probes in-memory without persisting to vault.
  ctx.output.write('  Testing key...\n');
  const start = Date.now();
  const testResult = await Promise.race([
    runLiveTestForKey(provider, key),
    new Promise<{ ok: false; latencyMs: number; errorCode: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, latencyMs: 10_000, errorCode: 'timeout' }), 10_000),
    ),
  ]);

  if (!testResult.ok) {
    const code = testResult.errorCode ?? 'unknown';
    if (code === 'timeout') {
      ctx.output.write(`  Provider slow to respond — try again? (code: timeout)\n`);
    } else {
      ctx.output.write(`  Key test failed (${code}). Not stored.\n`);
    }
    return;
  }

  const latency = Date.now() - start;

  // Atomic write — SPEC-153 (via manager.set which uses SecretStore).
  await manager.set(provider, key, { wsId: ctx.workspaceId || undefined });

  const masked = maskKey(key);
  logger.info({ provider, masked, wsId: ctx.workspaceId }, 'interactive_key_changed');
  ctx.output.write(`  Stored. Tested OK (${latency}ms)\n`);
}

/** Add a new key — uses provider picker, then changeKeyFlow. */
export async function addKeyFlow(
  ctx: KeyManagerContext,
  managerOverride?: ReturnType<typeof createKeyManager>,
): Promise<void> {
  const manager = managerOverride ?? createKeyManager();

  ctx.output.write('\n  Add key — paste your API key and we will detect the provider:\n');
  const input = ctx.input as NodeJS.ReadStream;
  const key = await promptApiKey({
    provider: 'auto-detect',
    prompt: '  API key (masked): ',
    input,
    output: ctx.output,
    clearOnExit: true,
  });

  const detected = detectProviderFromKey(key);
  if (!detected) {
    ctx.output.write(
      '  Could not detect provider from key prefix. Use: nimbus key set <provider> --key-stdin\n',
    );
    return;
  }

  ctx.output.write(`  Detected provider: ${detected.provider}\n`);
  // Re-use changeKeyFlow using the already-read key — but we need to skip the
  // second prompt. So we set the key via manager directly (after live-test).
  const start = Date.now();
  ctx.output.write('  Testing key...\n');
  const testResult = await Promise.race([
    runLiveTestForKey(detected.provider, key),
    new Promise<{ ok: false; latencyMs: number; errorCode: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, latencyMs: 10_000, errorCode: 'timeout' }), 10_000),
    ),
  ]);

  if (!testResult.ok) {
    ctx.output.write(`  Key test failed (${testResult.errorCode ?? 'unknown'}). Not stored.\n`);
    return;
  }
  const latency = Date.now() - start;
  await manager.set(detected.provider, key, {
    wsId: ctx.workspaceId || undefined,
    ...(detected.defaultBaseUrl ? { baseUrl: detected.defaultBaseUrl } : {}),
  });

  const masked = maskKey(key);
  logger.info({ provider: detected.provider, masked, wsId: ctx.workspaceId }, 'interactive_key_added');
  ctx.output.write(`  Stored ${detected.provider} key. Tested OK (${latency}ms)\n`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function testFlow(
  ctx: KeyManagerContext,
  provider: string,
  manager: ReturnType<typeof createKeyManager>,
): Promise<void> {
  ctx.output.write(`  Testing ${provider}...\n`);
  try {
    const result = await Promise.race([
      manager.test(provider, ctx.workspaceId || undefined),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 10_000),
      ),
    ]);
    if (result.ok) {
      ctx.output.write(`  ${provider}: OK (${result.latencyMs}ms)\n`);
    } else {
      ctx.output.write(`  ${provider}: FAIL (${result.errorCode ?? 'unknown'})\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.output.write(`  ${provider}: ERROR (${msg})\n`);
  }
}

async function removeFlow(
  ctx: KeyManagerContext,
  provider: string,
  manager: ReturnType<typeof createKeyManager>,
): Promise<void> {
  const confirm = await promptLine(ctx, `  Type "${provider}" to confirm deletion: `);
  if (confirm.trim() !== provider) {
    ctx.output.write('  Cancelled.\n');
    return;
  }
  await manager.delete(provider, ctx.workspaceId || undefined);
  ctx.output.write(`  Deleted ${provider} key.\n`);
  logger.info({ provider, wsId: ctx.workspaceId }, 'interactive_key_removed');
}

async function runLiveTestForKey(
  provider: string,
  key: string,
): Promise<{ ok: boolean; latencyMs: number; errorCode?: string }> {
  // Use a throw-away manager that wraps the live-test logic from manager.ts.
  // We inject a secretStore that returns our in-memory key without persisting.
  const fakeStore = {
    backend: 'file-fallback' as const,
    async get(_service: string, _account: string): Promise<string> {
      return key;
    },
    async set(): Promise<void> { /* no-op */ },
    async delete(): Promise<void> { /* no-op */ },
    async list(): Promise<string[]> { return [`provider:${provider}`]; },
  };
  const tmpManager = createKeyManager({ secretStore: fakeStore });
  try {
    return await tmpManager.test(provider);
  } catch (err) {
    const code = err instanceof NimbusError ? err.code : ErrorCode.P_NETWORK;
    return { ok: false, latencyMs: 0, errorCode: code };
  }
}

async function promptLine(ctx: KeyManagerContext, prompt: string): Promise<string> {
  ctx.output.write(prompt);
  const { createInterface } = await import('node:readline');
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: ctx.input, output: ctx.output, terminal: false });
    rl.question('', (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

function formatAge(createdAt: number): string {
  if (!createdAt) return '';
  const diffMs = Date.now() - createdAt;
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1d ago';
  return `${diffDays}d ago`;
}

