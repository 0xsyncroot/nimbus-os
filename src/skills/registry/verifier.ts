// verifier.ts — SPEC-310 T3: Sigstore keyless verification + Rekor offline cache.
// Uses cosign/sigstore conceptually. For v0.3 we implement the verification protocol
// with offline Rekor checkpoint caching. Actual sigstore npm pkg integration is stubbed
// to avoid heavy dependency (plugin can wire real sigstore in v0.3.1).

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import type { RegistryEntry } from './client.ts';

const REKOR_CACHE_TTL_MS = 60 * 60 * 1000; // 1h per ADR spec

interface RekorCacheEntry {
  digest: string;
  verifiedAt: number;
  bundleDigest: string;
  logIndex?: number;
}

function rekorCacheDir(): string {
  return join(homedir(), '.nimbus', 'registry', 'rekor');
}

function rekorCachePath(digest: string): string {
  const safe = digest.replace(/[^a-f0-9]/g, '');
  return join(rekorCacheDir(), `${safe}.json`);
}

async function readRekorCache(digest: string): Promise<RekorCacheEntry | null> {
  try {
    const raw = await Bun.file(rekorCachePath(digest)).text();
    return JSON.parse(raw) as RekorCacheEntry;
  } catch {
    return null;
  }
}

async function writeRekorCache(entry: RekorCacheEntry): Promise<void> {
  await mkdir(rekorCacheDir(), { recursive: true });
  await Bun.write(rekorCachePath(entry.digest), JSON.stringify(entry));
}

/**
 * computeFileDigest — compute sha256 of a file and return "sha256:<hex>".
 */
export async function computeFileDigest(filePath: string): Promise<string> {
  const buf = await Bun.file(filePath).arrayBuffer();
  const hash = createHash('sha256').update(Buffer.from(buf)).digest('hex');
  return `sha256:${hash}`;
}

/**
 * verifyBundleIntegrity — checks the sha256 digest of the downloaded bundle
 * matches the registry entry's declared bundleDigest.
 */
export async function verifyBundleIntegrity(
  bundlePath: string,
  expectedDigest: string,
): Promise<void> {
  const actual = await computeFileDigest(bundlePath);
  if (actual !== expectedDigest) {
    throw new NimbusError(ErrorCode.X_AUDIT_BREAK, {
      reason: 'bundle_digest_mismatch',
      expected: expectedDigest,
      actual,
      path: bundlePath,
    });
  }
}

/**
 * VerificationResult — outcome of sigstore verify.
 */
export interface VerificationResult {
  ok: boolean;
  tier: 'trusted' | 'community' | 'local';
  fromCache: boolean;
  logIndex?: number;
  verifiedAt: number;
}

/**
 * verifySigstore — main entry point for T3.
 *
 * Flow:
 * 1. LOCAL tier → skip sigstore, return ok (sandbox still enforced).
 * 2. Check Rekor offline cache (TTL 1h).
 * 3. If cache miss or expired → call external verifier (stub in v0.3; real in v0.3.1).
 * 4. Write result to cache.
 *
 * For v0.3 the "external verifier" is stubbed: COMMUNITY bundles without a
 * signatureUrl are treated as UNVERIFIED → throw X_AUDIT_BREAK.
 * TRUSTED bundles require a signatureUrl (also stub-verified in v0.3).
 */
export async function verifySigstore(
  entry: RegistryEntry,
  bundlePath: string,
): Promise<VerificationResult> {
  const digest = entry.bundleDigest;
  const now = Date.now();

  // LOCAL: no sigstore needed
  if (entry.tier === 'local') {
    logger.debug({ name: entry.name }, 'sigstore_skip_local');
    return { ok: true, tier: 'local', fromCache: false, verifiedAt: now };
  }

  // Check offline cache
  const cached = await readRekorCache(digest);
  if (cached && now - cached.verifiedAt < REKOR_CACHE_TTL_MS) {
    logger.debug({ name: entry.name, digest }, 'sigstore_cache_hit');
    return {
      ok: true,
      tier: entry.tier,
      fromCache: true,
      logIndex: cached.logIndex,
      verifiedAt: cached.verifiedAt,
    };
  }

  // COMMUNITY without signature URL — reject
  if (!entry.signatureUrl) {
    throw new NimbusError(ErrorCode.X_AUDIT_BREAK, {
      reason: 'missing_signature',
      name: entry.name,
      tier: entry.tier,
      hint: 'skill bundle has no cosign signature URL; rejected per sigstore policy',
    });
  }

  // Stub verification: in v0.3 we verify bundle digest matches + signature URL reachable.
  // Real sigstore OIDC verification deferred to v0.3.1 when sigstore npm is wired.
  try {
    const sigRes = await fetch(entry.signatureUrl, { signal: AbortSignal.timeout(10_000) });
    if (!sigRes.ok) {
      throw new NimbusError(ErrorCode.X_AUDIT_BREAK, {
        reason: 'signature_fetch_failed',
        status: sigRes.status,
        url: entry.signatureUrl,
      });
    }
    // Stub: treat reachable sig URL as "verified" for v0.3
    const cacheEntry: RekorCacheEntry = {
      digest,
      bundleDigest: entry.bundleDigest,
      verifiedAt: now,
    };
    await writeRekorCache(cacheEntry);
    logger.info({ name: entry.name, tier: entry.tier }, 'sigstore_verified_stub');
    return { ok: true, tier: entry.tier, fromCache: false, verifiedAt: now };
  } catch (err) {
    if (err instanceof NimbusError) throw err;
    // Network failure — check if we have a stale cache (7d tolerance per ADR-S06)
    if (cached) {
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (now - cached.verifiedAt < sevenDays) {
        logger.warn({ name: entry.name }, 'sigstore_offline_stale_cache_ok');
        return {
          ok: true,
          tier: entry.tier,
          fromCache: true,
          logIndex: cached.logIndex,
          verifiedAt: cached.verifiedAt,
        };
      }
    }
    throw new NimbusError(ErrorCode.X_AUDIT_BREAK, {
      reason: 'sigstore_verification_failed',
      name: entry.name,
      detail: (err as Error).message,
    });
  }
}
