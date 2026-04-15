---
id: SPEC-402
title: Rule parser + matcher (Bash/Path/Net)
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: permissions
depends_on: [META-003]
blocks: [SPEC-401, SPEC-403]
estimated_loc: 120
files_touched:
  - src/permissions/rule.ts
  - src/permissions/matcher.ts
  - tests/permissions/rule.test.ts
  - tests/permissions/matcher.test.ts
---

# Rule Parser + Matcher

## 1. Outcomes

- Parse rule strings like `Bash(git:*)`, `Write(~/projects/**)`, `WebFetch(github.com/*)` into a typed AST in <0.2ms
- Matcher takes `(rule, invocation) → 'allow' | 'ask' | 'deny' | 'no-match'` in <0.1ms per rule
- Wildcards `*` (single path segment, stops at `/` and `:`) and `**` (recursive, crosses separators), literal escapes via `\`
- Deterministic precedence (see §4): **most-specific pattern** wins; ties broken by family rank `deny > ask > allow`; final tie broken by last rule of same literal pattern

## 2. Scope

### 2.1 In-scope
- Rule grammar: `<ToolName>(<pattern>) [- allow|ask|deny]`
- Tokenizer handling escaped `\(`, `\:`, `\*`, `\\`
- Wildcards: `*` (segment), `**` (recursive for paths), literal `?` reserved (not supported v0.1)
- Compile rule list → `CompiledRuleSet` (array + index by tool name)
- Matcher: linear scan within tool bucket (v0.1), trie optimization deferred v0.3

### 2.2 Out-of-scope
- Mode gate composition → SPEC-401
- Bash command-line lexing (split tokens, redirections) → SPEC-403
- Rule source merging (user vs workspace vs CLI) → SPEC-501

## 3. Constraints

### Technical
- Zod validates rule strings at load; invalid rule → `S_CONFIG_INVALID`
- Parser is pure (no I/O), synchronous
- Max rule length 512 chars; max rules per set 10K (DoS guard)

### Performance
- Parse 10K rules <50ms cold
- Match one invocation <1ms across 10K rule set (bench)

## 4. Prior Decisions

- **Claude Code-style rule syntax** — familiar to users migrating, avoids inventing new grammar
- **Escape with `\` not quotes** — matches shell expectation, rule strings are one-liners
- **Linear scan not trie v0.1** — 10K rules × 1ms is fine; trie adds 200 LoC not justified MVP
- **`ask` as first-class outcome** — Claude Code `default` mode needs interactive prompt semantics baked in
- **Precedence = specificity-first, family-rank-second, last-wins-third** — resolves reviewer-flagged ambiguity between "deny > ask > allow" and "later rule wins". Specificity score = count of literal (non-wildcard) characters. Pattern `rm:-i*` (literal "rm:-i") beats `rm:*` (literal "rm:") regardless of decision. When two matched rules tie on specificity, family rank (`deny`=3, `ask`=2, `allow`=1) applied. When family rank ties, last declaration in source order wins. Motivation: users expect narrow carve-outs (`rm:-i*` allow) to override broad bans (`rm:*` deny), mirroring how `.gitignore` unignore patterns work.
- **`*` stops at `/` and `:`** — single-segment semantics; `Bash(git:*)` matches `git:commit` but NOT `git:sub cmd`; use `**` for recursive

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Rule tokenizer + parser | Fixtures: 30 valid + 20 invalid → correct AST / throw `S_CONFIG_INVALID` | 50 | — |
| T2 | Wildcard matcher | `git:*` matches `git commit`, `git:push`; `**` matches recursively | 30 | T1 |
| T3 | `CompiledRuleSet` + lookup | Index by tool name, preserve order for precedence | 25 | T1 |
| T4 | Precedence resolver | Specificity score → family rank → declaration order; fixtures cover all 3 tie-break levels | 15 | T3 |

## 6. Verification

### 6.1 Unit Tests
- `rule.test.ts`:
  - `Bash(git:*)` → `{tool: 'Bash', pattern: 'git:*', decision: default}`
  - `Bash(git\:*)` → literal colon in pattern
  - Invalid `Bash(` → throws `S_CONFIG_INVALID` with position
- `matcher.test.ts`:
  - `Bash(git:*)` matches `{name:'Bash', input:{cmd:'git commit -m x'}}` ✔
  - `Write(~/src/**)` matches `~/src/a/b.ts` but not `~/docs/a`
  - Specificity: `Bash(rm:*)` deny + `Bash(rm:-i*)` allow → `rm -i foo` → **allow** (narrower literal wins over broader ban)
  - Family rank on tie: `Bash(rm:*)` allow + `Bash(rm:*)` deny (same pattern) → **deny** (last declaration rank-tied → family rank wins)
  - Last-wins on full tie: `Bash(git:*)` allow declared twice with different sources → last in merged order wins
  - Wildcard separator: `Bash(git:*)` does NOT match input `git:sub cmd` (space stops `*`); `Bash(git:**)` does match
  - Ask cache interaction: `Bash(rm:*)` ask → user confirms twice → on 3rd matching invocation, gate returns cached `allow` (per SPEC-401 session cache, keyed by `{tool:'Bash', pattern:'rm:*'}`)

### 6.2 Security Checks
- Null bytes in pattern rejected
- Pattern longer than 512 → reject
- Regex-like metachars NOT interpreted (no `.*`, `\d`)

### 6.3 Performance Budgets
- `bench/matcher.bench.ts`: 10K rules × 1K invocations → avg <1ms

## 7. Interfaces

```ts
export const RuleStringSchema = z.string().min(3).max(512)

export interface Rule {
  tool: string              // 'Bash' | 'Write' | 'WebFetch' | ...
  pattern: string           // canonical pattern
  decision: Decision        // 'allow' | 'ask' | 'deny'
  source: 'user' | 'workspace' | 'cli' | 'builtin'
  raw: string
}

export interface CompiledRuleSet {
  byTool: Map<string, Rule[]>
  all: Rule[]
}

export function parseRule(input: string, decision: Decision, source: Rule['source']): Rule
export function compileRules(rules: Rule[]): CompiledRuleSet
export function matchRule(set: CompiledRuleSet, inv: ToolInvocation): Decision | 'no-match'
```

## 8. Files Touched

- `src/permissions/rule.ts` (~70 LoC)
- `src/permissions/matcher.ts` (~50 LoC)
- `tests/permissions/rule.test.ts` (~120 LoC)
- `tests/permissions/matcher.test.ts` (~100 LoC)

## 9. Open Questions

- [ ] Should we support `!` negation in rule patterns? (defer v0.2)
- [ ] Named rule groups (`@my-safe-set`) for reuse (defer v0.2)

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: revise per reviewer — resolve precedence ambiguity (specificity → family rank → last-wins, documented in §4); define `*` separator behavior; document ask cache interaction with SPEC-401
