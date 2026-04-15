// SPEC-903 T5 — file cache (TTL 7d, mode 0644) + curated fallback via priceTable.
import { createHash } from 'node:crypto';
import { mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { dataDir } from '../platform/paths.ts';
import { logger } from '../observability/logger.ts';
import { PRICE_TABLE } from '../cost/priceTable.ts';
import type { Price } from '../cost/priceTable.ts';
import {
  ModelDescriptorSchema,
  type ModelDescriptor,
  MAX_MODELS,
} from './types.ts';
import { enrichClass } from './classify.ts';

export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CacheFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.string(),
    endpoint: z.string(),
    fetchedAt: z.number().int().nonnegative(),
    models: z.array(ModelDescriptorSchema),
  })
  .strict();
type CacheFile = z.infer<typeof CacheFileSchema>;

export function endpointHash8(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 8);
}

export function catalogDir(): string {
  return join(dataDir(), 'catalog');
}

export function catalogPath(provider: string, endpoint: string): string {
  return join(catalogDir(), `${provider}-${endpointHash8(endpoint)}.json`);
}

export async function writeCache(
  provider: string,
  endpoint: string,
  models: ModelDescriptor[],
): Promise<void> {
  await mkdir(catalogDir(), { recursive: true });
  const payload: CacheFile = {
    schemaVersion: 1,
    provider,
    endpoint,
    fetchedAt: Date.now(),
    models,
  };
  const path = catalogPath(provider, endpoint);
  await writeFile(path, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
  try {
    await chmod(path, 0o644);
  } catch {
    // windows: chmod may not apply; ignore
  }
}

export interface ReadCacheResult {
  hit: boolean;
  stale?: boolean;
  models?: ModelDescriptor[];
}

export async function readCache(
  provider: string,
  endpoint: string,
  now: number = Date.now(),
  ttlMs: number = CATALOG_TTL_MS,
): Promise<ReadCacheResult> {
  const path = catalogPath(provider, endpoint);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = CacheFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn({ path, err: parsed.error.message }, 'catalog_cache_corrupt');
      return { hit: false };
    }
    const age = now - parsed.data.fetchedAt;
    const models = parsed.data.models.map((m) => ({ ...m, source: 'cache' as const }));
    if (age > ttlMs) return { hit: true, stale: true, models };
    return { hit: true, stale: false, models };
  } catch {
    return { hit: false };
  }
}

// Curated fallback from SPEC-701 priceTable — used when fetch fails AND no cache.
export function curatedFallback(provider: string): ModelDescriptor[] {
  const key = mapProvider(provider);
  if (key === undefined) return [];
  const table = PRICE_TABLE[key];
  if (!table) return [];
  const out: ModelDescriptor[] = [];
  for (const [id, price] of Object.entries(table) as Array<[string, Price]>) {
    if (id === '*') continue;
    const desc: ModelDescriptor = {
      id,
      provider,
      classHint: price.class,
      priceHint:
        price.in === 0 && price.out === 0
          ? 'unknown'
          : { in: price.in, out: price.out },
      source: 'curated',
    };
    out.push(desc);
  }
  return out;
}

function mapProvider(p: string): keyof typeof PRICE_TABLE | undefined {
  if (p === 'anthropic' || p === 'openai' || p === 'groq' || p === 'deepseek' || p === 'ollama') {
    return p;
  }
  return undefined;
}

export function truncateToMax(models: ModelDescriptor[]): ModelDescriptor[] {
  if (models.length <= MAX_MODELS) return models;
  logger.warn({ count: models.length, max: MAX_MODELS }, 'catalog_truncate');
  return models.slice(0, MAX_MODELS);
}

export function enrich(models: ModelDescriptor[]): ModelDescriptor[] {
  return truncateToMax(models.map(enrichClass));
}
