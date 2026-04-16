// workspaceTypes.ts — SPEC-101 schema + types.

import { z } from 'zod';

export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const WorkspaceSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(ULID_REGEX),
  name: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  createdAt: z.number().int().positive(),
  lastUsed: z.number().int().positive(),
  defaultProvider: z.string().default('anthropic'),
  defaultModel: z.string().default('claude-sonnet-4-6'),
  defaultEndpoint: z.enum(['openai', 'groq', 'deepseek', 'ollama', 'custom']).optional(),
  defaultBaseUrl: z.string().url().optional(),
  // SPEC-823 T3 — additive boot-tracking fields; no migration required
  lastBootAt: z.number().int().nonnegative().optional(),
  numStartups: z.number().int().nonnegative().optional(),
}).superRefine((val, ctx) => {
  if (val.defaultEndpoint === 'custom' && !val.defaultBaseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultBaseUrl'],
      message: 'defaultBaseUrl is required when defaultEndpoint="custom"',
    });
  }
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export interface WorkspacePaths {
  root: string;
  soulMd: string;
  identityMd: string;
  memoryMd: string;
  toolsMd: string;
  sessionsDir: string;
  costsDir: string;
}

export type WorkspaceEvent =
  | { type: 'workspace.created'; wsId: string }
  | { type: 'workspace.switched'; wsId: string };

export const WORKSPACE_JSON_MAX_BYTES = 8 * 1024;
