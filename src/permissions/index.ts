// permissions/index.ts — SPEC-401/402 barrel export.

export {
  PermissionModeSchema,
  assertImplemented,
  isValidTransition,
  getModeDescriptor,
  parseMode,
  narrow,
  READONLY_ALLOWED_TOOLS,
  DESTRUCTIVE_TOOLS,
  IMPLEMENTED_MODES,
} from './mode.ts';
export type { PermissionMode, ModeDescriptor } from './mode.ts';
export { parseRule, compileRules, DECISION_RANK, RuleStringSchema } from './rule.ts';
export type { Rule, CompiledRuleSet, Decision, RuleSource } from './rule.ts';
export { matchRule, matchPattern, ruleKey, extractMatchTarget, pickWinner } from './matcher.ts';
export { validatePath, inspectPath, getSensitivePatterns, __resetPathValidatorCache } from './pathValidator.ts';
export { createGate } from './gate.ts';
export type { Gate, GateOptions } from './gate.ts';
export type { PermissionContext, ToolInvocation, SideEffectTier } from './types.ts';
