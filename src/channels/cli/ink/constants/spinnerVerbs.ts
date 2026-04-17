// spinnerVerbs.ts — SPEC-843: Gerund verb list for SpinnerWithVerb rotation.
// 20 verbs for v0.4 MVP. Can grow to ~500 in v0.4.1 (see SPEC-843 §9).

/**
 * SPINNER_VERBS — 20 present-participle gerund verbs shown beside the spinner.
 * Used in random rotation by SpinnerWithVerb.tsx.
 */
export const SPINNER_VERBS: readonly string[] = [
  'Thinking',
  'Reasoning',
  'Analyzing',
  'Processing',
  'Generating',
  'Composing',
  'Planning',
  'Evaluating',
  'Considering',
  'Researching',
  'Reviewing',
  'Computing',
  'Synthesizing',
  'Crafting',
  'Exploring',
  'Reflecting',
  'Preparing',
  'Calculating',
  'Drafting',
  'Formulating',
] as const;
