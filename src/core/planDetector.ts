// planDetector.ts — SPEC-108: pure plan-mode heuristic for general-purpose AI OS.

export type Heuristic = 'H1' | 'H2' | 'H3';

export interface PlanDecision {
  plan: boolean;
  reason: string;
  matchedHeuristic?: Heuristic;
}

export const CUE_WORDS: readonly string[] = Object.freeze([
  // General
  'plan', 'organize', 'prepare', 'coordinate', 'orchestrate', 'consolidate',
  'reconcile', 'map out', 'set up',
  'tổ chức', 'sắp xếp', 'chuẩn bị', 'lên kế hoạch',
  // Research / synthesis
  'research', 'investigate', 'analyze', 'compare', 'summarize across', 'evaluate',
  'nghiên cứu', 'phân tích', 'so sánh', 'tổng hợp',
  // Bulk ops
  'migrate', 'reorganize', 'cleanup', 'restructure', 'batch', 'bulk',
  'toàn bộ', 'tất cả', 'hàng loạt',
  // Code
  'refactor', 'rewrite', 'overhaul', 'rearchitect',
  // Communication
  'compose campaign', 'draft series', 'reply to all', 'outreach',
  'soạn loạt', 'gửi cho',
]);

export const TOOL_NAMES: readonly string[] = Object.freeze([
  'read', 'write', 'edit', 'grep', 'glob', 'bash',
  'mail', 'email', 'calendar', 'lịch',
  'browser', 'web', 'search',
  'file', 'files', 'tệp',
  'archive', 'screenshot', 'photo',
]);

export const SCOPE_REGEX: RegExp = /(\d+)\s*(file|loc|line|email|message|tab|item|task|event|record|tệp|thư|mục|việc|sự kiện|photo|screenshot|contact|người)/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CUE_REGEXES: ReadonlyArray<{ word: string; re: RegExp }> = CUE_WORDS.map((w) => ({
  word: w,
  re: new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(w)}($|[^\\p{L}\\p{N}_])`, 'iu'),
}));

const TOOL_REGEXES: ReadonlyArray<{ name: string; re: RegExp }> = TOOL_NAMES.map((n) => ({
  name: n,
  re: new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(n)}($|[^\\p{L}\\p{N}_])`, 'iu'),
}));

export const PLAN_CUE_BLOCK = '[PLAN_MODE_REQUESTED]';

export function detectPlanMode(input: string): PlanDecision {
  if (typeof input !== 'string') {
    return { plan: false, reason: 'input_not_string' };
  }
  const text = input.slice(0, 10_000);

  // H1 cue word match
  for (const { word, re } of CUE_REGEXES) {
    if (re.test(text)) {
      return { plan: true, reason: `cue word '${word}' matched`, matchedHeuristic: 'H1' };
    }
  }

  // H2 distinct tool mentions
  const matchedTools = new Set<string>();
  for (const { name, re } of TOOL_REGEXES) {
    if (re.test(text)) matchedTools.add(name);
    if (matchedTools.size >= 3) break;
  }
  if (matchedTools.size >= 3) {
    return {
      plan: true,
      reason: `3+ tool mentions: ${[...matchedTools].join(',')}`,
      matchedHeuristic: 'H2',
    };
  }

  // H3 scope number ≥5
  const m = text.match(SCOPE_REGEX);
  if (m) {
    const n = Number.parseInt(m[1] ?? '0', 10);
    if (Number.isFinite(n) && n >= 5) {
      return {
        plan: true,
        reason: `scope ${n} ${m[2] ?? ''}`.trim(),
        matchedHeuristic: 'H3',
      };
    }
  }

  return { plan: false, reason: 'no heuristic matched' };
}

export function renderPlanCue(decision: PlanDecision): string {
  if (!decision.plan) return '';
  return `${PLAN_CUE_BLOCK}\nreason: ${decision.reason}\nheuristic: ${decision.matchedHeuristic ?? 'unknown'}`;
}
