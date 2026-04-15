// links.ts — cross-reference resolver for [SPEC-XXX], [META-YYY], [MOD-ZZ] (SPEC-911 T3)

import type { ParsedSpec } from './parser.ts';

const REF_REGEX = /\b(SPEC|META|MOD)-(\d{3})\b/g;

/**
 * Extract all referenced spec IDs from a body or depends_on array.
 */
export function extractRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(REF_REGEX)) refs.add(m[0]);
  return [...refs];
}

/**
 * Build an index from spec ID → file path.
 */
export function buildIdIndex(all: ParsedSpec[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const s of all) idx.set(s.frontmatter.id, s.path);
  return idx;
}

/**
 * Resolve `depends_on` and inline `[SPEC-XXX]` references.
 * Returns map of ref → path (or 'ERR_UNKNOWN_SPEC' if not found).
 */
export function resolveLinks(spec: ParsedSpec, all: ParsedSpec[]): Map<string, string> {
  const idx = buildIdIndex(all);
  const result = new Map<string, string>();

  // From frontmatter depends_on
  for (const dep of spec.frontmatter.depends_on) {
    result.set(dep, idx.get(dep) ?? 'ERR_UNKNOWN_SPEC');
  }

  // From body inline refs
  for (const ref of extractRefs(spec.body)) {
    if (!result.has(ref)) {
      result.set(ref, idx.get(ref) ?? 'ERR_UNKNOWN_SPEC');
    }
  }

  return result;
}

/**
 * Detect cycles in depends_on graph. Returns first cycle found (as path) or null.
 */
export function detectCycles(all: ParsedSpec[]): string[] | null {
  const idx = buildIdIndex(all);
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): string[] | null {
    if (stack.has(id)) {
      const cycleStart = path.indexOf(id);
      return [...path.slice(cycleStart), id];
    }
    if (visited.has(id)) return null;
    visited.add(id);
    stack.add(id);
    path.push(id);

    const spec = all.find((s) => s.frontmatter.id === id);
    if (spec) {
      for (const dep of spec.frontmatter.depends_on) {
        if (!idx.has(dep)) continue;
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }

    stack.delete(id);
    path.pop();
    return null;
  }

  for (const s of all) {
    const cycle = dfs(s.frontmatter.id);
    if (cycle) return cycle;
  }
  return null;
}
