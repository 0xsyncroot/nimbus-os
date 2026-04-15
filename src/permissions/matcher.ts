// matcher.ts — SPEC-402: wildcard matcher + precedence resolver.
//
// Precedence (see §4): highest specificity score → family rank (deny>ask>allow)
// → declaration order (last wins).

import { DECISION_RANK, type CompiledRuleSet, type Decision, type Rule } from './rule.ts';
import type { ToolInvocation } from './types.ts';

export function matchRule(set: CompiledRuleSet, inv: ToolInvocation): Decision | 'no-match' {
  const bucket = set.byTool.get(inv.name);
  if (!bucket || bucket.length === 0) return 'no-match';
  const target = extractMatchTarget(inv);
  if (target === null) return 'no-match';

  let winner: Rule | null = null;
  for (const rule of bucket) {
    if (!matchPattern(rule.pattern, target)) continue;
    if (winner === null) {
      winner = rule;
      continue;
    }
    winner = pickWinner(winner, rule);
  }
  return winner ? winner.decision : 'no-match';
}

export function pickWinner(a: Rule, b: Rule): Rule {
  if (a.specificity !== b.specificity) {
    return a.specificity > b.specificity ? a : b;
  }
  const ra = DECISION_RANK[a.decision];
  const rb = DECISION_RANK[b.decision];
  if (ra !== rb) return ra > rb ? a : b;
  return a.order >= b.order ? a : b;
}

export function ruleKey(rule: Rule): string {
  return `${rule.tool}:${rule.pattern}`;
}

/**
 * Extract the string token that rules match against for a given invocation.
 * - Bash → `cmd` string
 * - Read/Write/Edit/Glob/Grep → `path` or `filePath`
 * - WebFetch/WebSearch → `url` or `query`
 * Returns null if no matchable target present.
 */
export function extractMatchTarget(inv: ToolInvocation): string | null {
  const input = inv.input;
  const get = (k: string): string | null => {
    const v = input[k];
    return typeof v === 'string' ? v : null;
  };
  if (inv.name === 'Bash') return get('cmd') ?? get('command');
  if (inv.name === 'WebFetch') return get('url');
  if (inv.name === 'WebSearch') return get('query');
  return get('path') ?? get('filePath') ?? get('file_path');
}

/**
 * Match a compiled pattern against a target string.
 * Wildcards:
 *   \c  → literal c (escapes)
 *   **  → greedy, crosses separators
 *   *   → single segment; stops at '/', ':' and whitespace
 *   other → literal
 */
export function matchPattern(pattern: string, target: string): boolean {
  const tokens = tokenize(pattern);
  return matchTokens(tokens, 0, target, 0);
}

type Token =
  | { type: 'literal'; value: string }
  | { type: 'star' }
  | { type: 'double-star' };

function tokenize(pattern: string): Token[] {
  const out: Token[] = [];
  let lit = '';
  const flush = () => {
    if (lit.length > 0) {
      out.push({ type: 'literal', value: lit });
      lit = '';
    }
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      lit += pattern[i + 1];
      i++;
      continue;
    }
    if (c === '*') {
      flush();
      if (pattern[i + 1] === '*') {
        out.push({ type: 'double-star' });
        i++;
      } else {
        out.push({ type: 'star' });
      }
      continue;
    }
    lit += c;
  }
  flush();
  return out;
}

function isStarStop(ch: string): boolean {
  // Per SPEC-402 §4: single `*` stops at `/` and `:` only.
  return ch === '/' || ch === ':';
}

function matchTokens(tokens: Token[], ti: number, target: string, si: number): boolean {
  if (ti >= tokens.length) return si >= target.length;
  const tok = tokens[ti]!;
  if (tok.type === 'literal') {
    if (target.startsWith(tok.value, si)) {
      return matchTokens(tokens, ti + 1, target, si + tok.value.length);
    }
    return false;
  }
  if (tok.type === 'double-star') {
    // Greedy: try every remaining prefix position.
    for (let k = si; k <= target.length; k++) {
      if (matchTokens(tokens, ti + 1, target, k)) return true;
    }
    return false;
  }
  // single star: consume 0+ chars but stop at separators.
  for (let k = si; k <= target.length; k++) {
    if (matchTokens(tokens, ti + 1, target, k)) return true;
    if (k < target.length && isStarStop(target[k]!)) break;
  }
  return false;
}
