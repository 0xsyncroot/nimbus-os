// tests/skills/loader.test.ts — SPEC-320 T8: loader unit tests.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspaceSkills, loadBundledSkills, loadSkills } from '../../src/skills/loader.ts';
import { getBundledSkills } from '../../src/skills/bundled/index.ts';
import { NimbusError } from '../../src/observability/errors.ts';

// Minimal valid SKILL.md
const VALID_SKILL_MD = `---
name: testSkill
description: A test skill
whenToUse: testing purposes
permissions:
  sideEffects: pure
context: inline
---

Do the thing with $ARGUMENTS.
`;

const MALFORMED_SKILL_MD = `---
notAName: foo
---

Body here.
`;

const EMPTY_BODY_SKILL_MD = `---
name: emptyBody
description: Has no body
whenToUse: never
permissions:
  sideEffects: pure
context: inline
---
`;

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'nimbus-loader-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SPEC-320: skills loader', () => {
  test('loadBundledSkills returns all 7 bundled skills', () => {
    const map = loadBundledSkills();
    expect(map.size).toBe(7);
    for (const skill of getBundledSkills()) {
      expect(map.has(skill.name)).toBe(true);
    }
  });

  test('bundled skills all have required fields', () => {
    const map = loadBundledSkills();
    for (const [name, skill] of map) {
      expect(skill.name).toBe(name);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.whenToUse.length).toBeGreaterThan(0);
      expect(skill.body.length).toBeGreaterThan(0);
      expect(skill.source).toBe('bundled');
      expect(['inline', 'fork']).toContain(skill.context);
      expect(['pure', 'read', 'write', 'exec']).toContain(skill.permissions.sideEffects);
    }
  });

  test('loadWorkspaceSkills returns empty map when skills dir missing', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'nimbus-empty-'));
    const map = await loadWorkspaceSkills(emptyDir);
    expect(map.size).toBe(0);
    await rm(emptyDir, { recursive: true, force: true });
  });

  test('loadWorkspaceSkills finds valid SKILL.md files', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'nimbus-ws-'));
    const skillDir = join(wsDir, 'skills', 'testSkill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), VALID_SKILL_MD);

    const map = await loadWorkspaceSkills(wsDir);
    expect(map.size).toBe(1);
    expect(map.has('testSkill')).toBe(true);

    const skill = map.get('testSkill')!;
    expect(skill.source).toBe('workspace');
    expect(skill.name).toBe('testSkill');
    expect(skill.body).toContain('$ARGUMENTS');

    await rm(wsDir, { recursive: true, force: true });
  });

  test('loadWorkspaceSkills skips malformed SKILL.md (non-fatal)', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'nimbus-malformed-'));
    const badDir = join(wsDir, 'skills', 'badSkill');
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, 'SKILL.md'), MALFORMED_SKILL_MD);

    // Should not throw, just skip
    const map = await loadWorkspaceSkills(wsDir);
    expect(map.size).toBe(0);

    await rm(wsDir, { recursive: true, force: true });
  });

  test('loadWorkspaceSkills skips SKILL.md with empty body', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'nimbus-empty-body-'));
    const dir = join(wsDir, 'skills', 'emptyBody');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), EMPTY_BODY_SKILL_MD);

    const map = await loadWorkspaceSkills(wsDir);
    expect(map.size).toBe(0);

    await rm(wsDir, { recursive: true, force: true });
  });

  test('loadSkills: workspace skill overrides bundled by name', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'nimbus-override-'));
    // Override the bundled "plan" skill
    const planDir = join(wsDir, 'skills', 'plan');
    await mkdir(planDir, { recursive: true });
    const customPlan = `---
name: plan
description: Custom plan skill
whenToUse: custom plan trigger
permissions:
  sideEffects: pure
context: inline
---

Custom plan body for $ARGUMENTS.
`;
    await writeFile(join(planDir, 'SKILL.md'), customPlan);

    const merged = await loadSkills(wsDir);
    // Should still have all 7+ skills
    expect(merged.size).toBeGreaterThanOrEqual(7);

    const planSkill = merged.get('plan')!;
    expect(planSkill.source).toBe('workspace');
    expect(planSkill.description).toBe('Custom plan skill');
    expect(planSkill.body).toContain('Custom plan body');

    await rm(wsDir, { recursive: true, force: true });
  });

  test('loadSkills: bundled skills preserved when no workspace override', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'nimbus-nooverride-'));
    const merged = await loadSkills(wsDir);
    expect(merged.size).toBe(7);
    const commit = merged.get('commit')!;
    expect(commit.source).toBe('bundled');
    await rm(wsDir, { recursive: true, force: true });
  });

  test('parseFrontmatter rejects missing required fields', async () => {
    const { parseFrontmatter } = await import('../../src/skills/frontmatter.ts');
    const { ErrorCode } = await import('../../src/observability/errors.ts');
    expect(() => parseFrontmatter(MALFORMED_SKILL_MD, 'workspace', 'test.md')).toThrow();
    try {
      parseFrontmatter(MALFORMED_SKILL_MD, 'workspace', 'test.md');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.S_SOUL_PARSE);
    }
  });
});
