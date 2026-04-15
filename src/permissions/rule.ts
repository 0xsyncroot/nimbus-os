// rule.ts — SPEC-402: rule string parser + compiled set.
//
// Grammar: <ToolName>(<pattern>)
// decision supplied separately by caller (from rule source: allow/ask/deny list).
// Escapes: \( \) \: \* \\ inside pattern.
// Wildcards: * (single segment, stops at '/' and ':' — whitespace handled by matcher)
//            ** (recursive, crosses separators)

import { z } from 'zod';
import { ErrorCode, NimbusError } from '../observability/errors.ts';

export type Decision = 'allow' | 'ask' | 'deny';
export const DECISION_RANK: Record<Decision, number> = { allow: 1, ask: 2, deny: 3 };

export const RULE_PATTERN_MAX = 512;

export const RuleStringSchema = z.string().min(3).max(RULE_PATTERN_MAX);

export type RuleSource = 'user' | 'workspace' | 'cli' | 'builtin';

export interface Rule {
  tool: string;
  pattern: string; // canonical string form (with \ escapes preserved)
  decision: Decision;
  source: RuleSource;
  raw: string;
  order: number; // declaration index for last-wins tie-break
  specificity: number; // count of literal (non-wildcard) chars in pattern
}

export interface CompiledRuleSet {
  byTool: Map<string, Rule[]>;
  all: Rule[];
}

const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export function parseRule(input: string, decision: Decision, source: RuleSource, order = 0): Rule {
  const parsed = RuleStringSchema.safeParse(input);
  if (!parsed.success) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'rule_string_invalid',
      input,
      issues: parsed.error.issues.map((i) => i.message),
    });
  }
  if (input.indexOf('\0') !== -1) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, { reason: 'null_byte_in_rule', raw: input });
  }

  const openIdx = findUnescaped(input, '(');
  if (openIdx < 0) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'missing_open_paren',
      raw: input,
      pos: 0,
    });
  }
  const tool = input.slice(0, openIdx).trim();
  if (!TOOL_NAME_RE.test(tool)) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'invalid_tool_name',
      tool,
      raw: input,
    });
  }
  if (!input.endsWith(')')) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'missing_close_paren',
      raw: input,
      pos: input.length - 1,
    });
  }
  // Ensure the closing ) is not escaped.
  const last = input.length - 1;
  let backslashes = 0;
  for (let i = last - 1; i >= 0 && input[i] === '\\'; i--) backslashes++;
  if (backslashes % 2 === 1) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'escaped_close_paren',
      raw: input,
    });
  }
  const pattern = input.slice(openIdx + 1, last);
  validatePattern(pattern, input);

  return {
    tool,
    pattern,
    decision,
    source,
    raw: input,
    order,
    specificity: computeSpecificity(pattern),
  };
}

function validatePattern(pattern: string, raw: string): void {
  if (pattern.length === 0) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, { reason: 'empty_pattern', raw });
  }
  if (pattern.length > RULE_PATTERN_MAX) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, { reason: 'pattern_too_long', raw });
  }
  if (pattern.indexOf('\0') !== -1) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, { reason: 'null_byte_in_pattern', raw });
  }
  // Verify escape sequences are well-formed (no trailing lone backslash).
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      if (i === pattern.length - 1) {
        throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
          reason: 'trailing_backslash',
          raw,
        });
      }
      i++;
    }
  }
}

function findUnescaped(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === ch) return i;
  }
  return -1;
}

function computeSpecificity(pattern: string): number {
  let n = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      if (i + 1 < pattern.length) {
        n++;
        i++;
      }
      continue;
    }
    if (c === '*') continue;
    n++;
  }
  return n;
}

export function compileRules(rules: Rule[]): CompiledRuleSet {
  if (rules.length > 10_000) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'too_many_rules',
      count: rules.length,
    });
  }
  const byTool = new Map<string, Rule[]>();
  const all: Rule[] = [];
  rules.forEach((r, idx) => {
    const rule: Rule = { ...r, order: r.order !== 0 ? r.order : idx };
    all.push(rule);
    const bucket = byTool.get(rule.tool);
    if (bucket) bucket.push(rule);
    else byTool.set(rule.tool, [rule]);
  });
  return { byTool, all };
}
