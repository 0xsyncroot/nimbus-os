// validator.ts — 10 mandatory rules per SPEC-911 §6.1

import type { ParsedSpec } from './parser.ts';
import { canonicalSectionName } from './parser.ts';
import { buildIdIndex } from './links.ts';

export interface ValidationError {
  rule: number;
  code: string;
  path: string;
  line?: number;
}

const REQUIRED_SECTIONS_FEATURE = [
  'outcomes',
  'scope',
  'constraints',
  'prior decisions',
  'task breakdown',
  'verification',
];

const REQUIRED_SECTIONS_META = [
  'purpose',
  'consumers',
  'evolution policy',
];

const VALID_FILE_PREFIXES = ['src/', 'tests/', 'bench/', 'scripts/', 'examples/'];
const VALID_MD_PREFIX = 'src/onboard/templates/';

const WORD_COUNT_WARN = 800;
const WORD_COUNT_FAIL = 1500;

/**
 * Validate a single spec against all 10 rules.
 * `all` is required for cross-spec checks (rule 7: depends_on resolution + cycles).
 */
export function validateSpec(spec: ParsedSpec, all: ParsedSpec[] = [spec]): ValidationError[] {
  const errors: ValidationError[] = [];
  const fm = spec.frontmatter;

  // Rule 1: frontmatter present (always satisfied if parser succeeded)
  // Already enforced in parser.ts; included for completeness

  // Rule 2: id format
  if (!/^(SPEC|META|MOD)-\d{3}$/.test(fm.id)) {
    errors.push({
      rule: 2,
      code: `SPEC_VALIDATION: id format`,
      path: spec.path,
    });
  }

  // Rule 3: title length
  if (!fm.title || fm.title.length > 80) {
    errors.push({
      rule: 3,
      code: `SPEC_VALIDATION: title length (got ${fm.title?.length ?? 0}, max 80)`,
      path: spec.path,
    });
  }

  // Rule 4: status enum (Zod already validated, redundant but explicit)
  // -- skip, parser enforces

  // Rule 5: release required for SPEC-*
  if (fm.id.startsWith('SPEC-') && !fm.release) {
    errors.push({
      rule: 5,
      code: `SPEC_VALIDATION: release required for SPEC-*`,
      path: spec.path,
    });
  }

  // Rule 6: required body sections (different for META vs SPEC)
  const requiredSections = fm.id.startsWith('META-') ? REQUIRED_SECTIONS_META : REQUIRED_SECTIONS_FEATURE;
  for (const sec of requiredSections) {
    if (!hasSection(spec, sec)) {
      errors.push({
        rule: 6,
        code: `SPEC_VALIDATION: missing section ${sec}`,
        path: spec.path,
      });
    }
  }

  // Rule 7: depends_on resolve + no self-cycle
  const idx = buildIdIndex(all);
  for (const dep of fm.depends_on) {
    if (!idx.has(dep)) {
      errors.push({
        rule: 7,
        code: `SPEC_VALIDATION: unresolved dep ${dep}`,
        path: spec.path,
      });
    }
  }
  // self-cycle check
  if (fm.depends_on.includes(fm.id)) {
    errors.push({
      rule: 7,
      code: `SPEC_VALIDATION: dependency cycle (self-reference ${fm.id})`,
      path: spec.path,
    });
  }
  // transitive cycle (only if all > 1)
  if (all.length > 1) {
    const cyclePath = detectCycleStartingAt(spec.frontmatter.id, all);
    if (cyclePath) {
      errors.push({
        rule: 7,
        code: `SPEC_VALIDATION: dependency cycle via ${cyclePath.join(' → ')}`,
        path: spec.path,
      });
    }
  }

  // Rule 8: files_touched paths
  for (const p of fm.files_touched) {
    if (!isValidFilePath(p)) {
      errors.push({
        rule: 8,
        code: `SPEC_VALIDATION: bad path ${p}`,
        path: spec.path,
      });
    }
  }

  // Rule 9: body word count (excluding code blocks)
  const wordCount = countBodyWords(spec.body);
  if (wordCount > WORD_COUNT_FAIL) {
    errors.push({
      rule: 9,
      code: `SPEC_VALIDATION: body length fail (${wordCount} > ${WORD_COUNT_FAIL})`,
      path: spec.path,
    });
  }
  // Note: warn threshold (>800) returned separately via getWarnings()

  // Rule 10: changelog has ≥1 entry dated YYYY-MM-DD
  if (!hasDatedChangelogEntry(spec)) {
    errors.push({
      rule: 10,
      code: `SPEC_VALIDATION: changelog missing entry`,
      path: spec.path,
    });
  }

  return errors;
}

/**
 * Get warnings (non-blocking, exit 0).
 */
export function getWarnings(spec: ParsedSpec): ValidationError[] {
  const warnings: ValidationError[] = [];
  const wordCount = countBodyWords(spec.body);
  if (wordCount > WORD_COUNT_WARN && wordCount <= WORD_COUNT_FAIL) {
    warnings.push({
      rule: 9,
      code: `SPEC_VALIDATION: body length warn (${wordCount} > ${WORD_COUNT_WARN})`,
      path: spec.path,
    });
  }
  return warnings;
}

function hasSection(spec: ParsedSpec, name: string): boolean {
  return spec.sections.has(canonicalSectionName(name));
}

function isValidFilePath(p: string): boolean {
  if (VALID_FILE_PREFIXES.some((prefix) => p.startsWith(prefix))) return true;
  if (p.startsWith(VALID_MD_PREFIX) && p.endsWith('.md')) return true;
  return false;
}

function countBodyWords(body: string): number {
  // Strip code blocks
  const stripped = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  return stripped
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .length;
}

function hasDatedChangelogEntry(spec: ParsedSpec): boolean {
  const changelog = spec.sections.get('changelog');
  if (!changelog) return false;
  return /\d{4}-\d{2}-\d{2}/.test(changelog);
}

function detectCycleStartingAt(startId: string, all: ParsedSpec[]): string[] | null {
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): string[] | null {
    if (path.includes(id)) {
      const cycleStart = path.indexOf(id);
      return [...path.slice(cycleStart), id];
    }
    if (visited.has(id)) return null;
    visited.add(id);
    path.push(id);

    const spec = all.find((s) => s.frontmatter.id === id);
    if (spec) {
      for (const dep of spec.frontmatter.depends_on) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }

    path.pop();
    return null;
  }

  return dfs(startId);
}
