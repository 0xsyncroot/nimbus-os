// tests/permissions/rule.test.ts — SPEC-402 parser tests.

import { describe, expect, test } from 'bun:test';
import { parseRule, compileRules, type Rule } from '../../src/permissions/rule.ts';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';

describe('SPEC-402: rule parser', () => {
  test('parses Bash(git:*) with decision', () => {
    const r = parseRule('Bash(git:*)', 'allow', 'user');
    expect(r.tool).toBe('Bash');
    expect(r.pattern).toBe('git:*');
    expect(r.decision).toBe('allow');
    expect(r.source).toBe('user');
    expect(r.raw).toBe('Bash(git:*)');
  });

  test('parses Write(~/src/**)', () => {
    const r = parseRule('Write(~/src/**)', 'deny', 'workspace');
    expect(r.tool).toBe('Write');
    expect(r.pattern).toBe('~/src/**');
  });

  test('supports escaped colon via \\:', () => {
    const r = parseRule('Bash(git\\:*)', 'ask', 'cli');
    expect(r.pattern).toBe('git\\:*');
  });

  test('rejects missing closing paren', () => {
    expect(() => parseRule('Bash(git:*', 'allow', 'user')).toThrow(NimbusError);
    try {
      parseRule('Bash(git:*', 'allow', 'user');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.S_CONFIG_INVALID);
    }
  });

  test('rejects missing opening paren', () => {
    expect(() => parseRule('Bashgit:*)', 'allow', 'user')).toThrow(NimbusError);
  });

  test('rejects empty pattern', () => {
    expect(() => parseRule('Bash()', 'allow', 'user')).toThrow(NimbusError);
  });

  test('rejects null byte', () => {
    expect(() => parseRule('Bash(a\0b)', 'allow', 'user')).toThrow(NimbusError);
  });

  test('rejects invalid tool name', () => {
    expect(() => parseRule('123Tool(x)', 'allow', 'user')).toThrow(NimbusError);
  });

  test('rejects trailing lone backslash', () => {
    expect(() => parseRule('Bash(foo\\)', 'allow', 'user')).toThrow(NimbusError);
  });

  test('specificity counts literal chars only (wildcards excluded)', () => {
    const broad = parseRule('Bash(rm:*)', 'deny', 'builtin');
    const narrow = parseRule('Bash(rm:-i*)', 'allow', 'builtin');
    expect(narrow.specificity).toBeGreaterThan(broad.specificity);
  });

  test('compileRules buckets by tool + assigns order', () => {
    const rules = [
      parseRule('Bash(git:*)', 'allow', 'user'),
      parseRule('Write(/tmp/**)', 'deny', 'user'),
      parseRule('Bash(rm:*)', 'ask', 'user'),
    ];
    const set = compileRules(rules);
    expect(set.byTool.get('Bash')?.length).toBe(2);
    expect(set.byTool.get('Write')?.length).toBe(1);
    expect(set.all[0]!.order).toBe(0);
    expect(set.all[2]!.order).toBe(2);
  });

  test('compileRules rejects >10K rules', () => {
    const many: Rule[] = [];
    for (let i = 0; i < 10_001; i++) many.push(parseRule('Bash(x)', 'allow', 'user'));
    expect(() => compileRules(many)).toThrow(NimbusError);
  });

  test('rejects pattern longer than 512', () => {
    const long = 'x'.repeat(600);
    expect(() => parseRule(`Bash(${long})`, 'allow', 'user')).toThrow(NimbusError);
  });

  test('rejects strings shorter than 3', () => {
    expect(() => parseRule('a', 'allow', 'user')).toThrow(NimbusError);
  });
});
