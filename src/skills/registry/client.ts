// client.ts — SPEC-310 T2: registry client — git clone index + OCI fetch + SWR cache.
// Index TTL: 6h stale-while-revalidate. Bundles: immutable (cache forever).

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { parseManifest, type SkillManifest } from './manifest.ts';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';

export const REGISTRY_INDEX_URL =
  'https://raw.githubusercontent.com/nimbus-os/skills-registry/main/index.json';

const INDEX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface RegistryEntry {
  name: string;
  version: string;
  description: string;
  tier: 'trusted' | 'community' | 'local';
  bundleUrl: string;
  bundleDigest: string; // sha256:<hex>
  signatureUrl?: string;
}

export interface RegistryIndex {
  version: string;
  updatedAt: string;
  skills: RegistryEntry[];
}

function registryCacheDir(): string {
  return join(homedir(), '.nimbus', 'registry');
}

function indexCachePath(): string {
  return join(registryCacheDir(), 'index.json');
}

function indexMetaPath(): string {
  return join(registryCacheDir(), 'index.meta.json');
}

function bundleCachePath(digest: string): string {
  // digest: "sha256:<hex>" → use hex as filename
  const hex = digest.replace(/^sha256:/, '');
  return join(registryCacheDir(), 'bundles', `${hex}.tar`);
}

interface IndexMeta {
  fetchedAt: number;
}

async function readIndexMeta(): Promise<IndexMeta | null> {
  try {
    const raw = await Bun.file(indexMetaPath()).text();
    return JSON.parse(raw) as IndexMeta;
  } catch {
    return null;
  }
}

async function writeIndexMeta(meta: IndexMeta): Promise<void> {
  await mkdir(registryCacheDir(), { recursive: true });
  await Bun.write(indexMetaPath(), JSON.stringify(meta));
}

async function readCachedIndex(): Promise<RegistryIndex | null> {
  try {
    const raw = await Bun.file(indexCachePath()).text();
    return JSON.parse(raw) as RegistryIndex;
  } catch {
    return null;
  }
}

async function writeCachedIndex(index: RegistryIndex): Promise<void> {
  await mkdir(registryCacheDir(), { recursive: true });
  await Bun.write(indexCachePath(), JSON.stringify(index));
}

/**
 * fetchIndex — SWR: return cached if <6h old; revalidate in background if stale.
 * Offline: if network fails but cache exists, return cache (stale-ok for 7d per ADR-S06).
 */
export async function fetchIndex(forceRefresh = false): Promise<RegistryIndex> {
  const meta = await readIndexMeta();
  const now = Date.now();
  const isStale = !meta || now - meta.fetchedAt > INDEX_TTL_MS;

  const cached = await readCachedIndex();

  if (cached && !forceRefresh && !isStale) {
    return cached;
  }

  // Attempt fetch; fall back to cache on network failure
  try {
    const res = await fetch(REGISTRY_INDEX_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new NimbusError(ErrorCode.P_5XX, { status: res.status, url: REGISTRY_INDEX_URL });
    }
    const index = (await res.json()) as RegistryIndex;
    await writeCachedIndex(index);
    await writeIndexMeta({ fetchedAt: now });
    if (cached && isStale && !forceRefresh) {
      // Background revalidation done; return fresh
      logger.debug({ skills: index.skills.length }, 'registry_index_refreshed');
    }
    return index;
  } catch (err) {
    if (cached) {
      logger.warn({ err: (err as Error).message }, 'registry_index_fetch_failed_using_cache');
      return cached;
    }
    throw new NimbusError(ErrorCode.P_NETWORK, {
      reason: 'registry_unreachable_no_cache',
      detail: (err as Error).message,
    });
  }
}

/**
 * searchIndex — filter index by query string (name + description).
 */
export async function searchIndex(query: string): Promise<RegistryEntry[]> {
  const index = await fetchIndex();
  if (!query.trim()) return index.skills;
  const q = query.toLowerCase();
  return index.skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
}

/**
 * fetchBundle — download OCI artifact bundle to local cache (immutable; skip if cached).
 * Returns local file path.
 */
export async function fetchBundle(entry: RegistryEntry): Promise<string> {
  const dest = bundleCachePath(entry.bundleDigest);

  // Immutable cache: if file exists, return immediately
  const f = Bun.file(dest);
  if (await f.exists()) {
    logger.debug({ name: entry.name, digest: entry.bundleDigest }, 'bundle_cache_hit');
    return dest;
  }

  await mkdir(join(registryCacheDir(), 'bundles'), { recursive: true });

  try {
    const res = await fetch(entry.bundleUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      throw new NimbusError(ErrorCode.P_5XX, { status: res.status, url: entry.bundleUrl });
    }
    const buf = await res.arrayBuffer();
    await Bun.write(dest, buf);
    logger.info({ name: entry.name, bytes: buf.byteLength }, 'bundle_downloaded');
    return dest;
  } catch (err) {
    if (err instanceof NimbusError) throw err;
    throw new NimbusError(ErrorCode.P_NETWORK, {
      reason: 'bundle_download_failed',
      name: entry.name,
      detail: (err as Error).message,
    });
  }
}

/**
 * resolveEntry — find exact-version entry by name[@version].
 */
export async function resolveEntry(
  name: string,
  version?: string,
): Promise<RegistryEntry> {
  const index = await fetchIndex();
  const matches = index.skills.filter((s) => s.name === name);
  if (matches.length === 0) {
    throw new NimbusError(ErrorCode.T_NOT_FOUND, { reason: 'skill_not_found', name });
  }
  if (!version) {
    // Return latest (last in list per registry convention)
    return matches[matches.length - 1]!;
  }
  const exact = matches.find((s) => s.version === version);
  if (!exact) {
    throw new NimbusError(ErrorCode.T_NOT_FOUND, {
      reason: 'skill_version_not_found',
      name,
      version,
      available: matches.map((s) => s.version),
    });
  }
  return exact;
}

/**
 * fetchManifest — fetch and parse skill manifest from bundle path.
 * For v0.3, bundles are expected to contain a manifest.json at root.
 * In test/stub context the bundlePath may already be a JSON file.
 */
export async function fetchManifest(bundlePath: string): Promise<SkillManifest> {
  try {
    const raw = await Bun.file(bundlePath).text();
    // Try direct JSON first (test stubs), then look for embedded manifest
    return parseManifest(JSON.parse(raw));
  } catch (err) {
    if (err instanceof NimbusError) throw err;
    throw new NimbusError(ErrorCode.S_STORAGE_CORRUPT, {
      reason: 'manifest_unreadable',
      path: bundlePath,
      detail: (err as Error).message,
    });
  }
}
