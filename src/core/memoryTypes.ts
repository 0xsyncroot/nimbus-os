// memoryTypes.ts — SPEC-104: schemas + types for SOUL/IDENTITY/MEMORY/TOOLS markdown files.

import { z } from 'zod';

export const SoulFrontmatterSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(64),
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type SoulFrontmatter = z.infer<typeof SoulFrontmatterSchema>;

export const IdentityFrontmatterSchema = z.object({
  schemaVersion: z.literal(1),
});
export type IdentityFrontmatter = z.infer<typeof IdentityFrontmatterSchema>;

export const MemoryFrontmatterSchema = z.object({
  schemaVersion: z.literal(1),
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;

export const ToolsFrontmatterSchema = z.object({
  schemaVersion: z.literal(1),
});
export type ToolsFrontmatter = z.infer<typeof ToolsFrontmatterSchema>;

export interface MarkdownFile {
  frontmatter: Record<string, unknown>;
  body: string;
  mtime: number;
  fallback?: boolean;
}

export interface WorkspaceMemory {
  soulMd: MarkdownFile;
  identityMd?: MarkdownFile;
  memoryMd: MarkdownFile;
  toolsMd: MarkdownFile;
  wsId: string;
  loadedAt: number;
}

export const MAX_FILE_BYTES = 256 * 1024;

export const DEFAULT_SOUL_BODY = `# SOUL

Agent persona scaffold. Edit this to define tone, values, and preferred style.

- Identity: helpful, curious, concise.
- Voice: friendly but direct.
- Values: truth over flattery; transparency over hedging.
`;

export const DEFAULT_MEMORY_BODY = `# MEMORY

Persistent notes across sessions. Agent appends learnings here via MemoryTool.
`;

export const DEFAULT_TOOLS_BODY = `# TOOLS

Runtime tool manifest (populated by TOOLS.md editor and tool registry).
`;
