// manager.ts — SPEC-902 T4: KeyManager set/list/delete/test via SecretStore.
//
// Namespacing (SPEC-902 §4): keyring service `nimbus-os.{wsId}`, account = `provider:{id}`.
// This isolates workspace keys so workspace-B cannot read workspace-A keys.
// SecretStore.list returns accounts per service — we use it to enumerate providers.

import { getBest, redactSecret, type SecretStore } from '../platform/secrets/index.ts';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { validateKeyFormat } from '../onboard/keyValidators.ts';
import { getActiveWorkspace } from '../core/workspace.ts';
import { logger } from '../observability/logger.ts';

const ACCOUNT_PREFIX = 'provider:';
const META_PREFIX = 'meta:';

export interface KeyTestResult {
  ok: boolean;
  latencyMs: number;
  costUsd: number;
  errorCode?: string;
}

export interface KeyListEntry {
  provider: string;
  masked: string;
  createdAt: number;
}

export interface KeySetOptions {
  baseUrl?: string;
  liveTest?: boolean;
  wsId?: string;
}

export interface KeyManager {
  set(provider: string, key: string, opts?: KeySetOptions): Promise<void>;
  list(wsId?: string): Promise<KeyListEntry[]>;
  delete(provider: string, wsId?: string): Promise<void>;
  test(provider: string, wsId?: string): Promise<KeyTestResult>;
  /** Returns the stored baseUrl for a provider, or undefined if none was recorded. */
  getBaseUrl(provider: string, wsId?: string): Promise<string | undefined>;
}

interface StoredMeta {
  createdAt: number;
  baseUrl?: string;
}

export function keyringServiceName(wsId: string): string {
  return `nimbus-os.${wsId}`;
}

function accountForProvider(provider: string): string {
  return `${ACCOUNT_PREFIX}${provider}`;
}

function metaAccount(provider: string): string {
  return `${META_PREFIX}${provider}`;
}

async function resolveWsId(wsId?: string): Promise<string> {
  if (wsId) return wsId;
  const active = await getActiveWorkspace();
  if (!active) {
    throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
      reason: 'no_active_workspace',
      hint: 'run `nimbus init` first',
    });
  }
  return active.id;
}

export function maskKey(raw: string): string {
  // `key list` redaction (SPEC-902 §6.3): never reveal more than prefix + last 4.
  const trimmed = redactSecret(raw);
  if (trimmed !== raw) {
    // redactSecret stripped to prefix — append last4 for display parity.
    const last4 = raw.length >= 4 ? raw.slice(-4) : '';
    return `${trimmed.replace(/\*+$/, '')}***${last4}`;
  }
  if (raw.length <= 8) return '***';
  return `${raw.slice(0, 3)}***${raw.slice(-4)}`;
}

export interface KeyManagerDeps {
  secretStore?: SecretStore;
  testKey?: (provider: string, key: string, baseUrl?: string) => Promise<KeyTestResult>;
}

export function createKeyManager(deps: KeyManagerDeps = {}): KeyManager {
  const storePromise: Promise<SecretStore> = deps.secretStore
    ? Promise.resolve(deps.secretStore)
    : getBest();
  const testImpl = deps.testKey ?? defaultLiveTest;

  async function getStore(): Promise<SecretStore> {
    return storePromise;
  }

  return {
    async set(provider, key, opts = {}) {
      validateKeyFormat(provider, key, opts.baseUrl ? { baseUrl: opts.baseUrl } : {});
      const store = await getStore();
      const ws = await resolveWsId(opts.wsId);
      const service = keyringServiceName(ws);

      if (opts.liveTest) {
        const result = await testImpl(provider, key, opts.baseUrl);
        if (!result.ok) {
          throw new NimbusError(ErrorCode.P_AUTH, {
            reason: 'live_test_failed',
            provider,
            upstreamCode: result.errorCode,
          });
        }
      }

      await store.set(service, accountForProvider(provider), key);
      const meta: StoredMeta = { createdAt: Date.now() };
      if (opts.baseUrl) meta.baseUrl = opts.baseUrl;
      await store.set(service, metaAccount(provider), JSON.stringify(meta));

      logger.info(
        { provider, wsId: ws, hasBaseUrl: Boolean(opts.baseUrl) },
        'key_set',
      );
    },

    async list(wsId) {
      const store = await getStore();
      const ws = await resolveWsId(wsId);
      const service = keyringServiceName(ws);
      const accounts = await store.list(service);
      const entries: KeyListEntry[] = [];
      for (const acc of accounts) {
        if (!acc.startsWith(ACCOUNT_PREFIX)) continue;
        const provider = acc.slice(ACCOUNT_PREFIX.length);
        let raw: string;
        try {
          raw = await store.get(service, acc);
        } catch {
          continue;
        }
        let meta: StoredMeta = { createdAt: 0 };
        try {
          const metaRaw = await store.get(service, metaAccount(provider));
          meta = JSON.parse(metaRaw) as StoredMeta;
        } catch {
          // meta missing → skip timestamp enrichment
        }
        entries.push({ provider, masked: maskKey(raw), createdAt: meta.createdAt });
      }
      return entries;
    },

    async delete(provider, wsId) {
      const store = await getStore();
      const ws = await resolveWsId(wsId);
      const service = keyringServiceName(ws);
      try {
        await store.delete(service, accountForProvider(provider));
      } catch (err) {
        if (err instanceof NimbusError && err.code === ErrorCode.T_NOT_FOUND) {
          throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
            reason: 'key_not_found',
            provider,
            wsId: ws,
          });
        }
        throw err;
      }
      await store.delete(service, metaAccount(provider)).catch(() => undefined);
      logger.info({ provider, wsId: ws }, 'key_deleted');
    },

    async getBaseUrl(provider, wsId) {
      const store = await getStore();
      const ws = await resolveWsId(wsId);
      const service = keyringServiceName(ws);
      try {
        const metaRaw = await store.get(service, metaAccount(provider));
        const meta = JSON.parse(metaRaw) as StoredMeta;
        return meta.baseUrl;
      } catch {
        return undefined;
      }
    },

    async test(provider, wsId) {
      const store = await getStore();
      const ws = await resolveWsId(wsId);
      const service = keyringServiceName(ws);
      let key: string;
      try {
        key = await store.get(service, accountForProvider(provider));
      } catch {
        throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
          reason: 'key_not_found',
          provider,
          wsId: ws,
        });
      }
      let baseUrl: string | undefined;
      try {
        const metaRaw = await store.get(service, metaAccount(provider));
        const meta = JSON.parse(metaRaw) as StoredMeta;
        baseUrl = meta.baseUrl;
      } catch {
        // no meta — use provider defaults
      }
      return testImpl(provider, key, baseUrl);
    },
  };
}

async function defaultLiveTest(
  provider: string,
  key: string,
  baseUrl?: string,
): Promise<KeyTestResult> {
  const start = Date.now();
  const timeout = 5_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    if (provider === 'anthropic') {
      const { createAnthropicProvider } = await import('../providers/anthropic.ts');
      const p = createAnthropicProvider({
        apiKey: key,
        ...(baseUrl ? { baseUrl } : {}),
        defaultModel: 'claude-haiku-4-5-20251001',
      });
      const stream = p.stream(
        {
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 1,
          stream: true,
        },
        { signal: ac.signal },
      );
      // Consume one chunk to confirm auth passed.
      for await (const _ of stream) {
        break;
      }
      return { ok: true, latencyMs: Date.now() - start, costUsd: 0.00001 };
    }
    // Generic openai-compat providers: a 1-token ping
    const { createOpenAICompatProvider } = await import('../providers/openaiCompat.ts');
    const endpoint = provider === 'openai' ? 'openai' : provider === 'groq' ? 'groq' : provider === 'deepseek' ? 'deepseek' : provider === 'ollama' ? 'ollama' : 'custom';
    const p = createOpenAICompatProvider({
      endpoint: endpoint as 'openai' | 'groq' | 'deepseek' | 'ollama' | 'custom',
      ...(baseUrl ? { baseUrl } : {}),
      apiKey: key,
      defaultModel: 'gpt-4o-mini',
    });
    const stream = p.stream(
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        stream: true,
      },
      { signal: ac.signal },
    );
    for await (const _ of stream) break;
    return { ok: true, latencyMs: Date.now() - start, costUsd: 0.00001 };
  } catch (err) {
    const code = err instanceof NimbusError ? err.code : ErrorCode.P_NETWORK;
    const result: KeyTestResult = {
      ok: false,
      latencyMs: Date.now() - start,
      costUsd: 0,
      errorCode: code,
    };
    return result;
  } finally {
    clearTimeout(timer);
  }
}
