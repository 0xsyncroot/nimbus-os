// fileFallback.ts — AES-256-GCM encrypted JSON vault (SPEC-152 T5)
// Also exports autoProvisionPassphrase() used by init + key flows (SPEC-901 v0.2.1).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import type { SecretStore, VaultEnvelope } from './index.ts';
import { VaultEnvelopeSchema } from './index.ts';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';
import { nimbusHome } from '../paths.ts';
import { onTerminate } from '../signals.ts';

const VAULT_FILENAME = 'secrets.enc';
const MAX_VAULT_BYTES = 1_048_576; // 1 MB per SPEC-152 §3
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

type VaultData = Record<string, Record<string, string>>;

interface CachedKey {
  readonly key: Buffer;
  readonly salt: Buffer;
}

let cachedKey: CachedKey | null = null;
let zeroHandlerRegistered = false;

/** In-memory passphrase set by autoProvisionPassphrase() — takes priority over env var. */
let provisionedPassphrase: string | null = null;

function registerZeroOnExit(): void {
  if (zeroHandlerRegistered) return;
  zeroHandlerRegistered = true;
  onTerminate(() => {
    if (cachedKey) {
      cachedKey.key.fill(0);
      cachedKey.salt.fill(0);
      cachedKey = null;
    }
  });
}

function vaultPath(): string {
  return join(nimbusHome(), VAULT_FILENAME);
}

function getPassphrase(): string {
  if (provisionedPassphrase) return provisionedPassphrase;
  const pp = process.env['NIMBUS_VAULT_PASSPHRASE'];
  if (!pp) {
    throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
      reason: 'missing_passphrase',
      hint: 'set NIMBUS_VAULT_PASSPHRASE or call autoProvisionPassphrase() before use',
    });
  }
  return pp;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

async function readVault(): Promise<{ envelope: VaultEnvelope; raw: Buffer } | null> {
  const path = vaultPath();
  let raw: Buffer;
  try {
    const st = await stat(path);
    if (st.size > MAX_VAULT_BYTES) {
      throw new NimbusError(ErrorCode.S_STORAGE_CORRUPT, {
        reason: 'vault_too_large',
        size: st.size,
        max: MAX_VAULT_BYTES,
      });
    }
    raw = await readFile(path);
  } catch (err) {
    if (err instanceof NimbusError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new NimbusError(ErrorCode.S_STORAGE_CORRUPT, { reason: 'vault_read_failed' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new NimbusError(ErrorCode.S_STORAGE_CORRUPT, { reason: 'vault_json_parse' });
  }
  const result = VaultEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new NimbusError(ErrorCode.S_STORAGE_CORRUPT, { reason: 'vault_schema_mismatch' });
  }
  return { envelope: result.data, raw };
}

async function loadData(): Promise<VaultData> {
  registerZeroOnExit();
  const existing = await readVault();
  if (!existing) return {};

  const salt = Buffer.from(existing.envelope.salt, 'hex');
  const iv = Buffer.from(existing.envelope.iv, 'hex');
  const tag = Buffer.from(existing.envelope.tag, 'hex');
  const ct = Buffer.from(existing.envelope.ciphertext, 'base64');

  const key = ensureKey(salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8')) as unknown;
    plain.fill(0);
    if (!parsed || typeof parsed !== 'object') {
      throw new NimbusError(ErrorCode.S_STORAGE_CORRUPT, { reason: 'vault_payload_shape' });
    }
    return parsed as VaultData;
  } catch (err) {
    if (err instanceof NimbusError) throw err;
    throw new NimbusError(ErrorCode.X_CRED_ACCESS, { reason: 'tag_verify_fail' });
  }
}

function ensureKey(salt: Buffer): Buffer {
  if (cachedKey && cachedKey.salt.equals(salt)) return cachedKey.key;
  const pass = getPassphrase();
  const key = deriveKey(pass, salt);
  if (cachedKey) cachedKey.key.fill(0);
  cachedKey = { key, salt: Buffer.from(salt) };
  return key;
}

async function saveData(data: VaultData): Promise<void> {
  const salt = cachedKey?.salt ?? randomBytes(SALT_LEN);
  const key = ensureKey(salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(data), 'utf8');
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  plain.fill(0);

  const envelope: VaultEnvelope = {
    schemaVersion: 1,
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: ct.toString('base64'),
    tag: tag.toString('hex'),
  };
  const serialized = JSON.stringify(envelope);
  if (serialized.length > MAX_VAULT_BYTES) {
    throw new NimbusError(ErrorCode.S_STORAGE_CORRUPT, {
      reason: 'vault_would_exceed_limit',
      size: serialized.length,
    });
  }
  const path = vaultPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, { encoding: 'utf8' });
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
  }
}

export async function createFileFallback(): Promise<SecretStore> {
  return {
    backend: 'file-fallback',
    async set(service, account, value) {
      assertInputs(service, account);
      const data = await loadData();
      const bucket = data[service] ?? {};
      bucket[account] = value;
      data[service] = bucket;
      await saveData(data);
    },
    async get(service, account) {
      assertInputs(service, account);
      const data = await loadData();
      const v = data[service]?.[account];
      if (v === undefined) {
        throw new NimbusError(ErrorCode.T_NOT_FOUND, { backend: 'file-fallback', service, account });
      }
      return v;
    },
    async delete(service, account) {
      assertInputs(service, account);
      const data = await loadData();
      const bucket = data[service];
      if (!bucket || bucket[account] === undefined) {
        throw new NimbusError(ErrorCode.T_NOT_FOUND, { backend: 'file-fallback', service, account });
      }
      delete bucket[account];
      if (Object.keys(bucket).length === 0) delete data[service];
      await saveData(data);
    },
    async list(service) {
      assertInputs(service, 'list');
      const data = await loadData();
      return Object.keys(data[service] ?? {});
    },
  };
}

function assertInputs(service: string, account: string): void {
  if (!service || !account) {
    throw new NimbusError(ErrorCode.T_VALIDATION, { reason: 'empty_service_or_account' });
  }
  if (/[\0\n\r]/.test(service) || /[\0\n\r]/.test(account)) {
    throw new NimbusError(ErrorCode.X_INJECTION, { reason: 'control_char_in_identifier' });
  }
}

/** Test-only: drop cached key so the next op re-derives from env. */
export function __resetFileFallbackKey(): void {
  if (cachedKey) {
    cachedKey.key.fill(0);
    cachedKey.salt.fill(0);
    cachedKey = null;
  }
}

/** Test-only: reset provisioned passphrase. */
export function __resetProvisionedPassphrase(): void {
  provisionedPassphrase = null;
}

const VAULT_KEY_FILENAME = '.vault-key';

function vaultKeyFilePath(): string {
  return join(nimbusHome(), VAULT_KEY_FILENAME);
}

/**
 * autoProvisionPassphrase — ensure the vault has a passphrase before first use.
 * Priority:
 *   1. NIMBUS_VAULT_PASSPHRASE env var (CI/scripted installs)
 *   2. OS keychain (key: nimbus-os / vault-passphrase)
 *   3. ~/.nimbus/.vault-key file (0600) — generate + store on first run
 *   4. Interactive prompt (only if TTY available)
 *
 * After this call returns, getPassphrase() will succeed without throwing.
 */
export async function autoProvisionPassphrase(
  io?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream },
): Promise<void> {
  // 1. Already provisioned this process — skip.
  if (provisionedPassphrase) return;

  // 2. Env var takes highest precedence.
  const envPp = process.env['NIMBUS_VAULT_PASSPHRASE'];
  if (envPp) {
    provisionedPassphrase = envPp;
    return;
  }

  // 3. Try OS keychain/secret-service via getBest() — only if non-file backend.
  try {
    const { getBest } = await import('./index.ts');
    const store = await getBest();
    if (store.backend !== 'file-fallback') {
      try {
        const stored = await store.get('nimbus-os', 'vault-passphrase');
        if (stored && stored.length > 0) {
          provisionedPassphrase = stored;
          return;
        }
      } catch {
        // Not found in keychain — generate and store.
        const generated = randomBytes(32).toString('base64');
        await store.set('nimbus-os', 'vault-passphrase', generated);
        provisionedPassphrase = generated;
        return;
      }
    }
  } catch {
    // Keychain unavailable — fall through to file.
  }

  // 4. Try ~/.nimbus/.vault-key file.
  const keyFile = vaultKeyFilePath();
  try {
    const contents = await readFile(keyFile, { encoding: 'utf8' });
    const pp = contents.trim();
    if (pp.length > 0) {
      provisionedPassphrase = pp;
      return;
    }
  } catch {
    // File not found — will create below.
  }

  // 5. Generate a new passphrase and write to file.
  // If TTY available, we could prompt — but for a smoother UX, auto-generate silently.
  const output = io?.output ?? process.stdout;
  const generated = randomBytes(32).toString('base64');

  try {
    await mkdir(dirname(keyFile), { recursive: true });
    await writeFile(keyFile, generated, { encoding: 'utf8' });
    if (process.platform !== 'win32') {
      await chmod(keyFile, 0o600);
    }
    provisionedPassphrase = generated;
    return;
  } catch {
    // File write failed — try interactive prompt as last resort.
  }

  // 6. Interactive prompt (last resort — only if TTY).
  const input = io?.input ?? process.stdin;
  const isTTY = (input as { isTTY?: boolean }).isTTY === true;
  if (isTTY) {
    const rl = createInterface({ input, output: output as NodeJS.WritableStream, terminal: false });
    const pp = await new Promise<string>((resolve) => {
      rl.question('  Set a vault passphrase (saves to ~/.nimbus/.vault-key): ', (ans: string) => {
        rl.close();
        resolve(ans.trim());
      });
    });
    if (pp.length >= 8) {
      provisionedPassphrase = pp;
      try {
        await mkdir(dirname(keyFile), { recursive: true });
        await writeFile(keyFile, pp, { encoding: 'utf8' });
        if (process.platform !== 'win32') await chmod(keyFile, 0o600);
      } catch {
        // best-effort file write
      }
      return;
    }
  }

  // Nothing worked — will throw later when vault is actually used.
  // This avoids a hard failure during init before the key step.
}
