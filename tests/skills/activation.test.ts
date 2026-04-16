// tests/skills/activation.test.ts — SPEC-320 T8: activation unit tests.

import { describe, expect, test } from 'bun:test';
import {
  activateSkill,
  parseSlashCommand,
  type ActivationContext,
  type SkillRegistry,
} from '../../src/skills/activation.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import type { SkillDefinition } from '../../src/skills/types.ts';

function mkSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'testSkill',
    description: 'test',
    whenToUse: 'testing',
    permissions: { sideEffects: 'pure' },
    context: 'inline',
    body: 'Do the thing with $ARGUMENTS.',
    source: 'bundled',
    ...overrides,
  };
}

function mkRegistry(skills: SkillDefinition[] = []): SkillRegistry {
  const map = new Map(skills.map((s) => [s.name, s]));
  return { get: (name) => map.get(name) };
}

const DEFAULT_CTX: ActivationContext = { trigger: 'slash' };

describe('SPEC-320: skill activation', () => {
  test('slash command resolves and injects skill body', () => {
    const skill = mkSkill({ name: 'plan', body: 'Plan: $ARGUMENTS' });
    const registry = mkRegistry([skill]);
    const result = activateSkill('plan', 'build a REST API', registry, DEFAULT_CTX);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content).toBe('Plan: build a REST API');
  });

  test('$ARGUMENTS substitution works in body', () => {
    const skill = mkSkill({ body: 'Investigate: $ARGUMENTS and also $ARGUMENTS.' });
    const registry = mkRegistry([skill]);
    const result = activateSkill('testSkill', 'my question', registry, DEFAULT_CTX);
    expect(result.messages[0]!.content).toBe('Investigate: my question and also my question.');
  });

  test('$ARGUMENTS substitution with empty args leaves placeholder replaced', () => {
    const skill = mkSkill({ body: 'Do thing: $ARGUMENTS' });
    const registry = mkRegistry([skill]);
    const result = activateSkill('testSkill', '', registry, DEFAULT_CTX);
    expect(result.messages[0]!.content).toBe('Do thing: ');
  });

  test('unknown skill throws T_NOT_FOUND', () => {
    const registry = mkRegistry([]);
    expect(() => activateSkill('nonexistent', 'args', registry, DEFAULT_CTX)).toThrow();
    try {
      activateSkill('nonexistent', 'args', registry, DEFAULT_CTX);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_NOT_FOUND);
    }
  });

  test('contextModifier contains allowedTools when skill has them', () => {
    const skill = mkSkill({ allowedTools: ['Read', 'Grep'] });
    const registry = mkRegistry([skill]);
    const result = activateSkill('testSkill', '', registry, DEFAULT_CTX);
    expect(result.contextModifier?.allowedTools).toEqual(['Read', 'Grep']);
  });

  test('contextModifier is undefined when skill has no allowedTools', () => {
    const skill = mkSkill({ allowedTools: undefined });
    const registry = mkRegistry([skill]);
    const result = activateSkill('testSkill', '', registry, DEFAULT_CTX);
    expect(result.contextModifier).toBeUndefined();
  });

  test('bundled skill with exec sideEffects auto-allowed', () => {
    const skill = mkSkill({ source: 'bundled', permissions: { sideEffects: 'exec' } });
    const registry = mkRegistry([skill]);
    // Should not throw — bundled skills are trusted
    expect(() => activateSkill('testSkill', '', registry, DEFAULT_CTX)).not.toThrow();
  });

  test('workspace skill with exec sideEffects blocked without allowExec', () => {
    const skill = mkSkill({ source: 'workspace', permissions: { sideEffects: 'exec' } });
    const registry = mkRegistry([skill]);
    expect(() => activateSkill('testSkill', '', registry, DEFAULT_CTX)).toThrow();
    try {
      activateSkill('testSkill', '', registry, DEFAULT_CTX);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
    }
  });

  test('workspace skill with write sideEffects blocked without allowWrite', () => {
    const skill = mkSkill({ source: 'workspace', permissions: { sideEffects: 'write' } });
    const registry = mkRegistry([skill]);
    expect(() => activateSkill('testSkill', '', registry, { trigger: 'slash' })).toThrow();
  });

  test('workspace skill with write sideEffects allowed with allowWrite=true', () => {
    const skill = mkSkill({ source: 'workspace', permissions: { sideEffects: 'write' } });
    const registry = mkRegistry([skill]);
    const ctx: ActivationContext = { trigger: 'slash', allowWrite: true };
    expect(() => activateSkill('testSkill', 'args', registry, ctx)).not.toThrow();
  });

  test('workspace skill with exec sideEffects allowed with allowExec=true', () => {
    const skill = mkSkill({ source: 'workspace', permissions: { sideEffects: 'exec' } });
    const registry = mkRegistry([skill]);
    const ctx: ActivationContext = { trigger: 'slash', allowExec: true };
    expect(() => activateSkill('testSkill', 'args', registry, ctx)).not.toThrow();
  });

  describe('parseSlashCommand', () => {
    test('parses slash command with args', () => {
      const result = parseSlashCommand('/plan build a REST API');
      expect(result).toEqual({ name: 'plan', args: 'build a REST API' });
    });

    test('parses slash command without args', () => {
      const result = parseSlashCommand('/commit');
      expect(result).toEqual({ name: 'commit', args: '' });
    });

    test('returns null for non-slash input', () => {
      expect(parseSlashCommand('not a slash command')).toBeNull();
      expect(parseSlashCommand('')).toBeNull();
    });

    test('trims whitespace around input', () => {
      const result = parseSlashCommand('  /summarize  some content  ');
      expect(result).toEqual({ name: 'summarize', args: 'some content' });
    });
  });
});
