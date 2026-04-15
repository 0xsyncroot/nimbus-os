import { describe, expect, test } from 'bun:test';
import matter from 'gray-matter';
import { renderTemplates, __testing } from '../../src/onboard/templates.ts';
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
