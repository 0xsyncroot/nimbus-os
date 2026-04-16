// diagnose.ts — Read-only vault health check for startup + doctor (SPEC-505)
// Never throws. Classifies vault state into a typed VaultStatus.

import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nimbusHome } from '../paths.ts';
import { VaultEnvelopeSchema } from './index.ts';
import { createDecipheriv } from 'node:crypto';
import { scryptSync } from 'node:crypto';

const VAULT_FILENAME = 'secrets.enc';
const VAULT_KEY_FILENAME = '.vault-key';
const CURRENT_SCHEMA_VERSION = 1;

export type VaultStatusReason =
  | 'missing_file'
  | 'missing_passphrase'
  | 'decrypt_failed'
  | 'corrupt_envelope'
  | 'schema_old'
  | 'schema_newer';

export type VaultStatus =
  | { ok: true; schemaVersion: number }
  | { ok: false; reason: VaultStatusReason; details?: Record<string, unknown> };

function vaultPath(): string {
  return join(nimbusHome(), VAULT_FILENAME);
}

function vaultKeyPath(): string {
  return join(nimbusHome(), VAULT_KEY_FILENAME);
}

async function resolvePassphrase(): Promise<string | null> {
  // Priority: env > .vault-key file
  const envPp = process.env['NIMBUS_VAULT_PASSPHRASE'];
  if (envPp) return envPp;

  try {
    const contents = await readFile(vaultKeyPath(), { encoding: 'utf8' });
    const pp = contents.trim();
    if (pp.length > 0) return pp;
  } catch {
    // not found
  }

  // Try OS keychain passphrase (best-effort)
  try {
    const { getBest } = await import('./index.ts');
    const store = await getBest();
    if (store.backend !== 'file-fallback') {
      const stored = await store.get('nimbus-os', 'vault-passphrase');
      if (stored && stored.length > 0) return stored;
    }
  } catch {
    // keychain unavailable or not stored
  }

  return null;
}

/** Read-only vault health check. Never throws. */
export async function diagnoseVault(_wsId?: string): Promise<VaultStatus> {
  const path = vaultPath();

  // 1. Check vault file exists
  try {
    await stat(path);
  } catch {
    return { ok: false, reason: 'missing_file' };
  }

  // 2. Read + parse envelope
  let parsed: unknown;
  let raw: string;
  try {
    raw = await readFile(path, { encoding: 'utf8' });
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'corrupt_envelope', details: { stage: 'json_parse' } };
  }

  const result = VaultEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    // Check if it's a schema version issue
    const obj = parsed as Record<string, unknown>;
    const sv = typeof obj?.['schemaVersion'] === 'number' ? (obj['schemaVersion'] as number) : null;
    if (sv !== null && sv < CURRENT_SCHEMA_VERSION) {
      return { ok: false, reason: 'schema_old', details: { found: sv, current: CURRENT_SCHEMA_VERSION } };
    }
    if (sv !== null && sv > CURRENT_SCHEMA_VERSION) {
      return { ok: false, reason: 'schema_newer', details: { found: sv, current: CURRENT_SCHEMA_VERSION } };
    }
    return { ok: false, reason: 'corrupt_envelope', details: { zodErrors: result.error.issues } };
  }

  const envelope = result.data;

  // 3. Check schema version
  if (envelope.schemaVersion < CURRENT_SCHEMA_VERSION) {
    return { ok: false, reason: 'schema_old', details: { found: envelope.schemaVersion, current: CURRENT_SCHEMA_VERSION } };
  }
  if (envelope.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return { ok: false, reason: 'schema_newer', details: { found: envelope.schemaVersion, current: CURRENT_SCHEMA_VERSION } };
  }

  // 4. Resolve passphrase
  const passphrase = await resolvePassphrase();
  if (!passphrase) {
    return { ok: false, reason: 'missing_passphrase' };
  }

  // 5. Attempt decrypt (AES-256-GCM tag verify)
  try {
    const salt = Buffer.from(envelope.salt, 'hex');
    const iv = Buffer.from(envelope.iv, 'hex');
    const tag = Buffer.from(envelope.tag, 'hex');
    const ct = Buffer.from(envelope.ciphertext, 'base64');

    const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    plain.fill(0);
  } catch {
    return { ok: false, reason: 'decrypt_failed', details: { hint: 'wrong_passphrase_or_upgrade' } };
  }

  return { ok: true, schemaVersion: envelope.schemaVersion };
}
