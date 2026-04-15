// tests/permissions/matcher.test.ts — SPEC-402 matcher + precedence tests.

import { describe, expect, test } from 'bun:test';
import { compileRules, parseRule } from '../../src/permissions/rule.ts';
import { matchPattern, matchRule } from '../../src/permissions/matcher.ts';

function inv(name: string, input: Record<string, unknown>) {
  return { name, input };
}

describe('SPEC-402: pattern matcher', () => {
  test('single * matches within segment', () => {
    expect(matchPattern('git:*', 'git:commit')).toBe(true);
    expect(matchPattern('git:*', 'git:push')).toBe(true);
  });

  test('single * stops at / (path separator)', () => {
    // SPEC-402 §4: `*` is single-segment; stops at `/` and `:`.
    expect(matchPattern('git:*', 'git:sub/cmd')).toBe(false);
  });

  test('single * stops at / separator', () => {
    expect(matchPattern('~/src/*', '~/src/a/b.ts')).toBe(false);
    expect(matchPattern('~/src/*', '~/src/a.ts')).toBe(true);
  });

  test('** matches recursively across separators', () => {
    expect(matchPattern('~/src/**', '~/src/a/b/c.ts')).toBe(true);
    expect(matchPattern('~/src/**', '~/docs/a')).toBe(false);
    expect(matchPattern('git:**', 'git:sub/cmd/more')).toBe(true);
  });

  test('escaped backslash matches literal char', () => {
    expect(matchPattern('git\\:commit', 'git:commit')).toBe(true);
    expect(matchPattern('git\\*foo', 'git*foo')).toBe(true);
    expect(matchPattern('git\\*foo', 'gitXfoo')).toBe(false);
  });
});

describe('SPEC-402: rule matching + precedence', () => {
  test('Bash(git:*) matches git commit', () => {
    const set = compileRules([parseRule('Bash(git:*)', 'allow', 'user')]);
    expect(matchRule(set, inv('Bash', { cmd: 'git:commit' }))).toBe('allow');
  });

  test('no match → no-match', () => {
    const set = compileRules([parseRule('Bash(git:*)', 'allow', 'user')]);
    expect(matchRule(set, inv('Bash', { cmd: 'rm -rf /' }))).toBe('no-match');
  });

  test('specificity: narrow carve-out beats broad ban', () => {
    const set = compileRules([
      parseRule('Bash(rm:*)', 'deny', 'user'),
      parseRule('Bash(rm:-i*)', 'allow', 'user'),
    ]);
    expect(matchRule(set, inv('Bash', { cmd: 'rm:-i foo' }))).toBe('allow');
  });

  test('family rank on specificity tie: deny > ask > allow', () => {
    const set = compileRules([
      parseRule('Bash(rm:*)', 'allow', 'user'),
      parseRule('Bash(rm:*)', 'deny', 'user'),
    ]);
    expect(matchRule(set, inv('Bash', { cmd: 'rm:foo' }))).toBe('deny');
  });

  test('last-wins when specificity + family tie', () => {
    const a = parseRule('Bash(git:*)', 'allow', 'user');
    const b = parseRule('Bash(git:*)', 'allow', 'cli');
    const set = compileRules([a, b]);
    // Both identical decision+specificity; last declaration still applies.
    expect(matchRule(set, inv('Bash', { cmd: 'git:foo' }))).toBe('allow');
  });

  test('Write rule matches file_path input', () => {
    const set = compileRules([parseRule('Write(/tmp/**)', 'allow', 'user')]);
    expect(matchRule(set, inv('Write', { file_path: '/tmp/x/y.ts' }))).toBe('allow');
  });

  test('WebFetch rule matches url input', () => {
    const set = compileRules([parseRule('WebFetch(github.com/*)', 'allow', 'user')]);
    expect(matchRule(set, inv('WebFetch', { url: 'github.com/foo' }))).toBe('allow');
  });

  test('regex metachars are literal, not interpreted', () => {
    const set = compileRules([parseRule('Bash(a.b)', 'allow', 'user')]);
    // '.' is literal, not "any char"
    expect(matchRule(set, inv('Bash', { cmd: 'aXb' }))).toBe('no-match');
    expect(matchRule(set, inv('Bash', { cmd: 'a.b' }))).toBe('allow');
  });
});
