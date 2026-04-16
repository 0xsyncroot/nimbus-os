// manifest.ts — SPEC-310 T1: SkillManifest Zod schema + parse/validate.
// Max 400 LoC. No `any`. Bun-native.

import { z } from 'zod';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';

// sideEffects aligned to SPEC-103 / SPEC-301 four-category enum.
const SideEffectsSchema = z.enum(['pure', 'read', 'write', 'exec']);

const AuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
});

const PermissionsSchema = z.object({
  bash: z
    .object({
      allow: z.array(z.string()),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  fsRead: z.array(z.string()).optional(),
  fsWrite: z.array(z.string()).optional(),
  network: z.object({ hosts: z.array(z.string()) }).optional(),
  env: z.array(z.string()).optional(),
  sideEffects: SideEffectsSchema,
});

const TrustSchema = z.object({
  tier: z.enum(['trusted', 'community', 'local']),
  signedBy: z.string().optional(),
  bundleDigest: z.string().min(1), // sha256:... or placeholder for local
});

const EntrySchema = z.object({
  prompts: z.array(z.string()).optional(),
  code: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

export const SkillManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^(@[\w-]+\/)?[\w-]+$/, 'name must be scoped (@user/skill) or unscoped alphanumeric-dash'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, 'version must be semver'),
  description: z.string().min(1).max(140),
  author: AuthorSchema,
  license: z.string().min(1), // SPDX identifier
  minNimbusVersion: z
    .string()
    .regex(/^[\d.*^~>=<|]+/, 'minNimbusVersion must be semver range'),
  entry: EntrySchema,
  permissions: PermissionsSchema,
  trust: TrustSchema,
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type SkillPermissions = z.infer<typeof PermissionsSchema>;
export type TrustTier = z.infer<typeof TrustSchema>['tier'];

/**
 * parseManifest — parse + validate raw JSON/object as SkillManifest.
 * Throws NimbusError(T_VALIDATION) on schema failure.
 */
export function parseManifest(raw: unknown): SkillManifest {
  const result = SkillManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'invalid_skill_manifest',
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  return result.data;
}

/**
 * validateManifestJSON — parse from JSON string, throws T_VALIDATION on parse error or schema failure.
 */
export function validateManifestJSON(json: string): SkillManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'invalid_json',
      detail: (e as Error).message,
    });
  }
  return parseManifest(raw);
}
