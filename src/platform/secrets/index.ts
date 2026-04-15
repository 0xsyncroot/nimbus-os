// platform/secrets/index.ts — SecretStore interface + getBest() selector (SPEC-152 T1)

import { z } from 'zod';
import { detect } from '../detect.ts';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';
import { createFileFallback } from './fileFallback.ts';
import { createKeychainStore, isKeychainAvailable } from './keychain.ts';
import { createSecretServiceStore, isSecretServiceAvailable } from './secretService.ts';
import { createCredentialManagerStore, isCredentialManagerAvailable } from './credentialManager.ts';

export type SecretBackend = 'keychain' | 'secret-service' | 'credential-manager' | 'file-fallback';

export interface SecretStore {
  readonly backend: SecretBackend;
  set(service: string, account: string, value: string): Promise<void>;
  get(service: string, account: string): Promise<string>;
  delete(service: string, account: string): Promise<void>;
  list(service: string): Promise<string[]>;
}

export const VaultEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kdf: z.literal('scrypt'),
  salt: z.string().regex(/^[0-9a-f]{32}$/),
  iv: z.string().regex(/^[0-9a-f]{24}$/),
  ciphertext: z.string(),
  tag: z.string().regex(/^[0-9a-f]{32}$/),
});
export type VaultEnvelope = z.infer<typeof VaultEnvelopeSchema>;

let cached: SecretStore | null = null;

export async function getBest(): Promise<SecretStore> {
  if (cached) return cached;

  const forced = process.env['NIMBUS_SECRETS_BACKEND'];
  if (forced === 'file') {
    cached = await createFileFallback();
    return cached;
  }
  if (forced && forced !== 'file' && forced !== 'auto') {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'unknown_secrets_backend',
      value: forced,
    });
  }

  const caps = detect();
  if (caps.os === 'darwin' && (await isKeychainAvailable())) {
    cached = createKeychainStore();
    return cached;
  }
  if (caps.os === 'linux' && !caps.isWSL && (await isSecretServiceAvailable())) {
    cached = createSecretServiceStore();
    return cached;
  }
  if (caps.os === 'win32' && (await isCredentialManagerAvailable())) {
    cached = createCredentialManagerStore();
    return cached;
  }

  cached = await createFileFallback();
  return cached;
}

/** Test-only: clear the memo so env overrides can be re-evaluated. */
export function __resetSecretStoreCache(): void {
  cached = null;
}

const REDACTION_PREFIXES: readonly string[] = ['sk-ant-', 'sk-', 'ghp_', 'xai-'];

export function redactSecret(value: string): string {
  for (const prefix of REDACTION_PREFIXES) {
    if (value.startsWith(prefix) && value.length > prefix.length) {
      return `${prefix}***`;
    }
  }
  return value.length > 6 ? `${value.slice(0, 3)}***` : '***';
}
