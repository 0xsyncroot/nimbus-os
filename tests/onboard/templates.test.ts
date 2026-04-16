import { describe, expect, test } from 'bun:test';
import matter from 'gray-matter';
import { renderTemplates, DEFAULT_SOUL_MD, __testing } from '../../src/onboard/templates.ts';
import type { InitAnswers } from '../../src/onboard/questions.ts';

const baseAnswers: InitAnswers = {
  workspaceName: 'test-ws',
  primaryUseCase: 'daily assistant',
  voice: 'casual',
  language: 'en',
  provider: 'anthropic',
  modelClass: 'workhorse',
  bashPreset: 'balanced',
};

describe('SPEC-901: templates', () => {
  test('renderTemplates produces 6 files', () => {
    const files = renderTemplates(baseAnswers, '2026-04-15');
    expect(Object.keys(files).sort()).toEqual(
      ['CLAUDE.md', 'DREAMS.md', 'IDENTITY.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'],
    );
  });

  test('SOUL.md has valid frontmatter with schemaVersion=1 + created=today', () => {
    const files = renderTemplates(baseAnswers, '2026-04-15');
    const parsed = matter(files['SOUL.md']!);
    expect(parsed.data['schemaVersion']).toBe(1);
    const created = parsed.data['created'];
    const createdIso = created instanceof Date ? created.toISOString().slice(0, 10) : String(created);
    expect(createdIso).toBe('2026-04-15');
    expect(parsed.data['name']).toBe('test-ws');
    expect(parsed.content).toContain('daily assistant');
    expect(parsed.content).toContain('Voice: casual');
  });

  test('IDENTITY.md non-empty with frontmatter', () => {
    const files = renderTemplates(baseAnswers, '2026-04-15');
    const parsed = matter(files['IDENTITY.md']!);
    expect(parsed.data['schemaVersion']).toBe(1);
    expect(parsed.content.length).toBeGreaterThan(20);
  });

  test('DREAMS.md body heading matches spec', () => {
    const files = renderTemplates(baseAnswers, '2026-04-15');
    const parsed = matter(files['DREAMS.md']!);
    expect(parsed.data['schemaVersion']).toBe(1);
    expect(parsed.content).toContain('# Dream consolidations');
  });

  test('TOOLS.md includes bash preset rules', () => {
    const strict = renderTemplates({ ...baseAnswers, bashPreset: 'strict' }, '2026-04-15');
    expect(strict['TOOLS.md']).toContain('Preset: **strict**');
    expect(strict['TOOLS.md']).toContain('Never run destructive');
    const permissive = renderTemplates({ ...baseAnswers, bashPreset: 'permissive' }, '2026-04-15');
    expect(permissive['TOOLS.md']).toContain('Preset: **permissive**');
  });

  test('substitute throws on missing var', () => {
    expect(() => __testing.substitute('${missing}', {})).toThrow();
  });
});

// SPEC-123: action-first bias — Values bullets use verbs, no gate patterns
describe('SPEC-123: action-first Values in templates', () => {
  /** Extract lines in the # Values section (up to next # heading). */
  function extractValuesBullets(md: string): string[] {
    const lines = md.split('\n');
    let inValues = false;
    const bullets: string[] = [];
    for (const line of lines) {
      if (/^#+ Values/.test(line)) { inValues = true; continue; }
      if (inValues && /^#+/.test(line)) break;
      if (inValues && line.trimStart().startsWith('-')) {
        bullets.push(line.trim().slice(1).trim()); // strip leading "- "
      }
    }
    return bullets;
  }

  test('DEFAULT_SOUL_MD Values bullets do not use pure gate openers (Preview|Confirm before|Respect)', () => {
    const soul = DEFAULT_SOUL_MD('2026-04-16');
    const bullets = extractValuesBullets(soul);
    expect(bullets.length).toBeGreaterThan(0);
    for (const bullet of bullets) {
      // Pure gate patterns: "Preview before", "Confirm before", "Respect X"
      // "Confirm only before..." is the verb-first allowed form and is NOT matched by this regex.
      expect(bullet).not.toMatch(/^(Preview\b|Confirm before|Respect\b)/i);
    }
  });

  test('SOUL_TEMPLATE Values bullets do not use pure gate openers (Preview|Confirm before|Respect)', () => {
    const files = renderTemplates(baseAnswers, '2026-04-16');
    const soul = files['SOUL.md']!;
    const bullets = extractValuesBullets(soul);
    expect(bullets.length).toBeGreaterThan(0);
    for (const bullet of bullets) {
      expect(bullet).not.toMatch(/^(Preview\b|Confirm before|Respect\b)/i);
    }
  });

  test('DEFAULT_SOUL_MD Values bullets begin with verb from allowlist', () => {
    const verbAllowlist = /^(Start|Pick|Investigate|Act|Concise|Show|State|Confirm only)/i;
    const soul = DEFAULT_SOUL_MD('2026-04-16');
    const bullets = extractValuesBullets(soul);
    expect(bullets.length).toBeGreaterThan(0);
    for (const bullet of bullets) {
      expect(bullet).toMatch(verbAllowlist);
    }
  });

  test('SOUL_TEMPLATE (rendered) Boundaries section remains intact', () => {
    const files = renderTemplates(baseAnswers, '2026-04-16');
    const soul = files['SOUL.md']!;
    expect(soul).toContain('# Boundaries');
    expect(soul).toContain('Will NOT');
  });
});
