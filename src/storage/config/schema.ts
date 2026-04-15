// schema.ts — SPEC-501: Zod NimbusConfig schema + secret scanning refinement.

import { z } from 'zod';

export const PermissionModeSchema = z.enum([
  'readonly',
  'default',
  'bypass',
  'plan',
  'auto',
  'isolated',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const RuleStringSchema = z.string().min(3).max(512);

export const SecretRefSchema = z.object({
  ref: z.string().regex(/^keyring:[a-z][a-z0-9-]+$/),
});
export type SecretRef = z.infer<typeof SecretRefSchema>;

// SPEC-902: per-provider override entry — stored in config, safe to commit (no raw key).
export const ProviderEntrySchema = z
  .object({
    baseUrl: z.string().url().optional(),
    keyRef: z.string().regex(/^keyring:/).optional(),
    model: z.string().optional(),
  })
  .partial();
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bxoxb-[A-Za-z0-9-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];

export function containsRawSecret(s: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(s));
}

export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'groq',
  'deepseek',
  'ollama',
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const NimbusConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    provider: z
      .object({
        default: ProviderIdSchema.default('anthropic'),
        model: z.string().default('claude-opus-4-6'),
        baseUrl: z.string().url().optional(),
        keyRef: z.string().regex(/^keyring:/).optional(),
      })
      .default({ default: 'anthropic', model: 'claude-opus-4-6' }),
    providers: z.record(z.string(), ProviderEntrySchema).default({}),
    permissions: z
      .object({
        mode: PermissionModeSchema.default('default'),
        rules: z.array(RuleStringSchema).default([]),
      })
      .default({ mode: 'default', rules: [] }),
    logging: z
      .object({
        level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        retention: z
          .object({ metricsDays: z.number().int().positive().default(30) })
          .default({ metricsDays: 30 }),
      })
      .default({ level: 'info', retention: { metricsDays: 30 } }),
    cost: z
      .object({ trackEnabled: z.boolean().default(true) })
      .default({ trackEnabled: true }),
    profile: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (containsRawSecret(JSON.stringify(c))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'raw secret-shaped value detected — use {ref:"keyring:..."} instead',
        path: ['<scan>'],
      });
    }
  });

export type NimbusConfig = z.infer<typeof NimbusConfigSchema>;

export const NIMBUS_CONFIG_DEFAULTS: NimbusConfig = NimbusConfigSchema.parse({});

export type ConfigLayer =
  | 'cli'
  | 'env'
  | 'workspace'
  | 'profile'
  | 'user'
  | 'default';

export interface ConfigMergeTrace {
  field: string;
  value: unknown;
  source: ConfigLayer;
}

/**
 * Partial schema for layer validation — every layer except `default` is
 * partial; we only require full validation on the merged result.
 */
export const PartialNimbusConfigSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    provider: z
      .object({
        default: ProviderIdSchema.optional(),
        model: z.string().optional(),
        baseUrl: z.string().url().optional(),
        keyRef: z.string().regex(/^keyring:/).optional(),
      })
      .partial()
      .optional(),
    providers: z.record(z.string(), ProviderEntrySchema).optional(),
    permissions: z
      .object({
        mode: PermissionModeSchema.optional(),
        rules: z.array(RuleStringSchema).optional(),
      })
      .partial()
      .optional(),
    logging: z
      .object({
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        retention: z
          .object({ metricsDays: z.number().int().positive().optional() })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
    cost: z.object({ trackEnabled: z.boolean().optional() }).partial().optional(),
    profile: z.string().optional(),
  })
  .passthrough();

export type PartialNimbusConfig = z.infer<typeof PartialNimbusConfigSchema>;
