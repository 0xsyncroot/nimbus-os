// Provider registry — build a Provider from config (SPEC-202/203 factory dispatch).
// SPEC-902: priority chain CLI flag > env var > secrets store > config keyRef > error.
import type { Provider } from '../ir/types';
import { ErrorCode, NimbusError } from '../observability/errors';
import { createAnthropicProvider } from './anthropic';
import {
  createOpenAICompatProvider,
  ENDPOINTS,
  type EndpointName,
} from './openaiCompat';
import { getBest } from '../platform/secrets/index.ts';
import { keyringServiceName } from '../key/manager.ts';

export interface ProviderConfig {
  kind: 'anthropic' | 'openai-compat';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  endpoint?: EndpointName | 'custom';
}

export type KeySource = 'cli' | 'env' | 'secrets' | 'config';

export interface ResolvedKey {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  source: KeySource;
}

export interface ResolveKeyOpts {
  providerId: string;
  wsId?: string;
  cliKey?: string;
  cliBaseUrl?: string;
  configBaseUrl?: string;
  configKeyRef?: string;
}

const ENV_BY_PROVIDER: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  ollama: 'OLLAMA_API_KEY',
};

/**
 * Resolve the effective API key for a provider following SPEC-902 priority chain:
 * 1. CLI flag (--api-key or --key-from-env)
 * 2. Env var (e.g. ANTHROPIC_API_KEY) — unchanged pre-v0.1 path
 * 3. Secrets store (per-workspace keyring)
 * 4. Config `keyRef` pointer (→ secrets store lookup)
 * 5. Throw U_MISSING_CONFIG with actionable hint
 *
 * baseUrl resolution piggybacks on the chain:
 *   cliBaseUrl > configBaseUrl (workspace.json) > secret-store meta.baseUrl > undefined.
 * Env OPENAI_BASE_URL is applied by the REPL wiring layer (legacy compat) before
 * this resolver sees configBaseUrl.
 */
export async function resolveProviderKey(opts: ResolveKeyOpts): Promise<ResolvedKey> {
  const providerId = opts.providerId;
  const explicitBaseUrl = opts.cliBaseUrl ?? opts.configBaseUrl;
  const vaultBaseUrl = opts.wsId ? await lookupVaultBaseUrl(providerId, opts.wsId) : undefined;
  const chainBaseUrl = explicitBaseUrl ?? vaultBaseUrl;

  if (opts.cliKey) {
    const out: ResolvedKey = { provider: providerId, apiKey: opts.cliKey, source: 'cli' };
    if (chainBaseUrl) out.baseUrl = chainBaseUrl;
    return out;
  }

  const envVar = ENV_BY_PROVIDER[providerId];
  if (envVar) {
    const fromEnv = process.env[envVar];
    if (fromEnv && fromEnv.length > 0) {
      const out: ResolvedKey = { provider: providerId, apiKey: fromEnv, source: 'env' };
      if (chainBaseUrl) out.baseUrl = chainBaseUrl;
      return out;
    }
  }

  if (opts.wsId) {
    try {
      const store = await getBest();
      const raw = await store.get(keyringServiceName(opts.wsId), `provider:${providerId}`);
      const out: ResolvedKey = { provider: providerId, apiKey: raw, source: 'secrets' };
      if (chainBaseUrl) out.baseUrl = chainBaseUrl;
      return out;
    } catch {
      // fall through to config keyRef
    }
  }

  if (opts.configKeyRef) {
    throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
      reason: 'key_ref_unresolved',
      keyRef: opts.configKeyRef,
      provider: providerId,
      hint: `run \`nimbus key set ${providerId}\` to store the key`,
    });
  }

  throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
    reason: 'provider_key_missing',
    provider: providerId,
    hint: `run \`nimbus key set ${providerId}\` or set ${envVar ?? providerId.toUpperCase() + '_API_KEY'}`,
  });
}

async function lookupVaultBaseUrl(providerId: string, wsId: string): Promise<string | undefined> {
  try {
    const store = await getBest();
    const metaRaw = await store.get(keyringServiceName(wsId), `meta:${providerId}`);
    const meta = JSON.parse(metaRaw) as { baseUrl?: string };
    return meta.baseUrl;
  } catch {
    return undefined;
  }
}

export function createProviderFromConfig(cfg: ProviderConfig): Provider {
  if (cfg.kind === 'anthropic') {
    const apiKey = cfg.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
        reason: 'provider_key_missing',
        provider: 'anthropic',
        hint: 'run `nimbus key set anthropic` or set ANTHROPIC_API_KEY',
      });
    }
    return createAnthropicProvider({
      apiKey,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      defaultModel: cfg.model,
    });
  }
  if (cfg.kind === 'openai-compat') {
    const endpoint = cfg.endpoint ?? 'openai';
    if (endpoint !== 'custom' && !(endpoint in ENDPOINTS)) {
      throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
        reason: 'unknown endpoint',
        endpoint,
      });
    }
    return createOpenAICompatProvider({
      endpoint,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      defaultModel: cfg.model,
    });
  }
  throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
    reason: 'unsupported provider kind',
    kind: (cfg as { kind: string }).kind,
  });
}

/**
 * Build a provider by resolving the key via the SPEC-902 priority chain.
 * This is the preferred entry point post-v0.1.
 */
export async function createProviderWithResolvedKey(
  cfg: Omit<ProviderConfig, 'apiKey'> & { providerId: string; wsId?: string; cliKey?: string },
): Promise<Provider> {
  const resolved = await resolveProviderKey({
    providerId: cfg.providerId,
    ...(cfg.wsId ? { wsId: cfg.wsId } : {}),
    ...(cfg.cliKey ? { cliKey: cfg.cliKey } : {}),
    ...(cfg.baseUrl ? { cliBaseUrl: cfg.baseUrl } : {}),
  });
  const built: ProviderConfig = {
    kind: cfg.kind,
    model: cfg.model,
    apiKey: resolved.apiKey,
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
  };
  return createProviderFromConfig(built);
}
