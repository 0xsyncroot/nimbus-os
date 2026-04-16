// parser.ts — gray-matter wrapper + Zod schema for spec frontmatter (SPEC-911 T1)

import matter from 'gray-matter';
import { z } from 'zod';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';

export const SpecFrontmatterSchema = z
  .object({
    id: z.string().regex(/^(SPEC|META|MOD)-\d{3}$/, 'id must match (SPEC|META|MOD)-XXX'),
    title: z.string().min(3).max(80),
    status: z.enum(['draft', 'approved', 'in-progress', 'implemented', 'deprecated', 'superseded']),
    version: z.string(),
    owner: z.string(),
    created: z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)),
    updated: z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)),
    release: z.enum(['v0.1', 'v0.2', 'v0.3', 'v0.4', 'v0.5']).optional(),
    layer: z.string(),
    depends_on: z.array(z.string()).default([]),
    blocks: z.array(z.string()).default([]),
    estimated_loc: z.number().int().nonnegative().default(0),
    files_touched: z.array(z.string()).default([]),
    supersededBy: z.string().optional(),
  })
  .refine((d) => (d.id.startsWith('SPEC-') ? !!d.release : true), {
    message: 'release required for SPEC-* (not META/MOD)',
    path: ['release'],
  });

export type SpecFrontmatter = z.infer<typeof SpecFrontmatterSchema>;

export interface ParsedSpec {
  path: string;
  frontmatter: SpecFrontmatter;
  body: string;
  sections: Map<string, string>;
}

/**
 * Parse a `.spec.md` file. Throws NimbusError(S_CONFIG_INVALID) on bad frontmatter.
 */
export async function parseSpec(filePath: string): Promise<ParsedSpec> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new NimbusError(ErrorCode.T_NOT_FOUND, { path: filePath });
  }

  const raw = await file.text();
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      path: filePath,
      reason: 'frontmatter parse failed',
      cause: (err as Error).message,
    });
  }

  // Defensive: gray-matter may produce empty data on no frontmatter
  if (!parsed.data || Object.keys(parsed.data).length === 0) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      path: filePath,
      reason: 'frontmatter missing',
    });
  }

  const validation = SpecFrontmatterSchema.safeParse(parsed.data);
  if (!validation.success) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      path: filePath,
      reason: 'frontmatter schema invalid',
      issues: validation.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  return {
    path: filePath,
    frontmatter: validation.data,
    body: parsed.content,
    sections: extractSections(parsed.content),
  };
}

/**
 * Extract `## N. Section Name` headers and their content.
 * Returns Map keyed by canonical name (lowercase, no leading number).
 * E.g., "## 1. Outcomes" → key "outcomes".
 */
export function extractSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  // Match `## N. Name` or `## Name` (level-2 headers)
  const regex = /^##\s+(?:\d+\.\s+)?(.+?)\s*$/gm;
  const matches: { name: string; start: number; end: number }[] = [];

  let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    const name = m[1];
    if (!name) continue;
    matches.push({ name, start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    if (!cur) continue;
    const contentStart = cur.end;
    const contentEnd = next ? next.start : body.length;
    const content = body.slice(contentStart, contentEnd).trim();
    sections.set(canonicalSectionName(cur.name), content);
  }

  return sections;
}

/**
 * Canonicalize section name for matching:
 * "Outcomes" → "outcomes", "Task Breakdown" → "task breakdown", "Prior Decisions" → "prior decisions"
 */
export function canonicalSectionName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
