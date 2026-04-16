// keyValidators.ts — SPEC-902 T2: per-provider API key format validators.
//
// Custom-endpoint relaxation (bugfix #4): when baseUrl points to a non-official host
// (vLLM, Ollama remote, LM Studio, LiteLLM, Azure OpenAI proxy, etc.) providers may
// accept arbitrary / dummy keys. Only enforce a minimal sanity check in that case.

import { ErrorCode, NimbusError } from '../observability/errors.ts';

export const KEY_FORMAT_PATTERNS: Record<string, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_\-]{20,}$/,
  openai: /^sk-(proj-)?[A-Za-z0-9_\-]{20,}$/,
  groq: /^gsk_[A-Za-z0-9]{20,}$/,
  deepseek: /^sk-[A-Za-z0-9]{20,}$/,
  ollama: /^.*$/,
};

/**
 * Official hosted endpoints per provider. When baseUrl matches one of these,
 * the strict sk-/gsk_ regex applies. Any other host → relaxed validation.
 */
const OFFICIAL_HOSTS: Record<string, readonly string[]> = {
  anthropic: ['api.anthropic.com'],
  openai: ['api.openai.com'],
  groq: ['api.groq.com'],
  deepseek: ['api.deepseek.com'],
  ollama: [],
};

export interface ValidateKeyOptions {
  baseUrl?: string;
}

function isOfficialHost(provider: string, baseUrl: string | undefined): boolean {
  if (!baseUrl) return true; // no override → default provider endpoint
  const hosts = OFFICIAL_HOSTS[provider];
  if (!hosts || hosts.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.includes(hostname);
}

const MIN_CUSTOM_KEY_LEN = 1;
const MAX_KEY_LEN = 512;

export interface DetectedProvider {
  provider: string;
  kind: 'anthropic' | 'openai-compat';
  defaultModel: string;
  defaultEndpoint?: 'openai' | 'groq' | 'deepseek' | 'ollama' | 'custom';
  defaultBaseUrl?: string;
}

/**
 * Auto-detect provider from API key prefix.
 * Returns null when the key doesn't match any known prefix and the user should be asked.
 *
 * Prefix table:
 *   sk-ant-*   → anthropic / claude-sonnet-4-6
 *   sk-proj-*  → openai / gpt-5.4-mini
 *   sk-*       → openai / gpt-5.4-mini
 *   gsk_*      → groq  / llama-3.3-70b-versatile  (endpoint: groq)
 *   null       → unknown (ask user)
 */
export function detectProviderFromKey(key: string): DetectedProvider | null {
  if (key.startsWith('sk-ant-')) {
    return { provider: 'anthropic', kind: 'anthropic', defaultModel: 'claude-sonnet-4-6' };
  }
  if (key.startsWith('sk-proj-') || key.startsWith('sk-')) {
    return {
      provider: 'openai',
      kind: 'openai-compat',
      defaultModel: 'gpt-5.4-mini',
      defaultEndpoint: 'openai',
    };
  }
  if (key.startsWith('gsk_')) {
    return {
      provider: 'groq',
      kind: 'openai-compat',
      defaultModel: 'llama-3.3-70b-versatile',
      defaultEndpoint: 'groq',
      defaultBaseUrl: 'https://api.groq.com/openai/v1',
    };
  }
  return null;
}

export function validateKeyFormat(
  provider: string,
  key: string,
  opts: ValidateKeyOptions = {},
): void {
  const pattern = KEY_FORMAT_PATTERNS[provider];
  if (!pattern) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'unknown_provider',
      provider,
      known: Object.keys(KEY_FORMAT_PATTERNS),
    });
  }

  // Always block control characters / newlines regardless of endpoint.
  if (/[\0\n\r]/.test(key)) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'key_contains_control_chars',
      provider,
      keyLength: key.length,
    });
  }
  if (key.length > MAX_KEY_LEN) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'key_too_long',
      provider,
      keyLength: key.length,
      max: MAX_KEY_LEN,
    });
  }

  // Relaxed validation for custom openai-compat endpoints (vLLM / LM Studio /
  // Ollama remote / LiteLLM). Still enforce non-empty + ollama pattern stays permissive.
  if (!isOfficialHost(provider, opts.baseUrl)) {
    if (key.length < MIN_CUSTOM_KEY_LEN) {
      throw new NimbusError(ErrorCode.T_VALIDATION, {
        reason: 'key_empty',
        provider,
        customEndpoint: true,
      });
    }
    return;
  }

  if (!pattern.test(key)) {
    // NEVER log `key` — context only carries provider + length (no prefix/value).
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'key_format_mismatch',
      provider,
      keyLength: key.length,
    });
  }
}
