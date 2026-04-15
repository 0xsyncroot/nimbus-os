// SPEC-903 T1 — ModelDescriptor + Zod schema (shared by fetchers/store/picker).
import { z } from 'zod';

export const ModelClassEnum = z.enum([
  'flagship',
  'workhorse',
  'budget',
  'reasoning',
  'local',
]);
export type ModelClassHint = z.infer<typeof ModelClassEnum>;

export const ModelDescriptorSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    displayName: z.string().optional(),
    contextLength: z.number().int().positive().optional(),
    classHint: ModelClassEnum.optional(),
    priceHint: z
      .union([
        z.object({ in: z.number().nonnegative(), out: z.number().nonnegative() }),
        z.literal('unknown'),
      ])
      .optional(),
    source: z.enum(['live', 'cache', 'curated']),
    fetchedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export const FetchResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    models: z.array(ModelDescriptorSchema),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['auth', 'timeout', 'parse', 'network', 'http', 'too_large']),
    detail: z.string().optional(),
  }),
]);
export type FetchResult = z.infer<typeof FetchResultSchema>;

export interface FetcherOpts {
  timeoutMs: number;
  maxBytes?: number;
}

export interface ProviderCatalogFetcher {
  fetch(
    baseUrl: string,
    apiKey: string | null,
    opts: FetcherOpts,
  ): Promise<FetchResult>;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 500 * 1024;
export const MAX_MODELS = 200;
