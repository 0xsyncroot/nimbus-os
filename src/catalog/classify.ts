// SPEC-903 T7 — regex-based class inference for ModelDescriptor.classHint.
import type { ModelClassHint, ModelDescriptor } from './types.ts';

const CLASS_RULES: Array<{ re: RegExp; klass: ModelClassHint }> = [
  { re: /(opus|gpt-4\.5|gemini-[0-9]+-pro|flagship)/i, klass: 'flagship' },
  { re: /\b(o[1-9](?:-|\b)|gpt-[5-9](?:[.-]|\b)|deepseek-r[0-9]?|reasoner|thinking)/i, klass: 'reasoning' },
  { re: /(sonnet|gpt-4o\b(?!-mini)|gpt-4-turbo)/i, klass: 'workhorse' },
  { re: /(haiku|gpt-4o-mini|mini|flash-lite|3\.5-turbo|nano|phi-[0-9]+-mini)/i, klass: 'budget' },
  { re: /(llama|mistral|mixtral|qwen|gemma|phi|yi-?[0-9]+|command-r|kimi|glm|deepseek-v[0-9]+|deepseek-chat)/i, klass: 'local' },
];

export function inferClass(id: string): ModelClassHint | undefined {
  for (const rule of CLASS_RULES) {
    if (rule.re.test(id)) return rule.klass;
  }
  return undefined;
}

export function enrichClass(desc: ModelDescriptor): ModelDescriptor {
  if (desc.classHint !== undefined) return desc;
  const klass = inferClass(desc.id);
  if (!klass) return desc;
  return { ...desc, classHint: klass };
}
