// jsonSchema.ts — minimal Zod → JSON Schema converter for tool definitions.
// Handles primitives, objects (strict), arrays, enums, defaults, optional.
// Intentionally simple: only the shapes used by builtin tools.

import { z, type ZodTypeAny } from 'zod';

export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return convert(schema);
}

function convert(s: ZodTypeAny): Record<string, unknown> {
  const def = (s as { _def: { typeName: string; [k: string]: unknown } })._def;
  const tn = def.typeName;

  if (tn === 'ZodOptional') {
    return convert(def['innerType'] as ZodTypeAny);
  }
  if (tn === 'ZodDefault') {
    const inner = convert(def['innerType'] as ZodTypeAny);
    const df = (def['defaultValue'] as () => unknown)();
    return { ...inner, default: df };
  }
  if (tn === 'ZodNullable') {
    const inner = convert(def['innerType'] as ZodTypeAny);
    return { ...inner, nullable: true };
  }
  if (tn === 'ZodString') {
    const out: Record<string, unknown> = { type: 'string' };
    const checks = def['checks'] as Array<{ kind: string; value?: number; regex?: RegExp }> | undefined;
    if (checks) {
      for (const c of checks) {
        if (c.kind === 'min' && typeof c.value === 'number') out['minLength'] = c.value;
        if (c.kind === 'max' && typeof c.value === 'number') out['maxLength'] = c.value;
        if (c.kind === 'regex' && c.regex) out['pattern'] = c.regex.source;
      }
    }
    return out;
  }
  if (tn === 'ZodNumber') {
    const out: Record<string, unknown> = { type: 'number' };
    const checks = def['checks'] as Array<{ kind: string; value?: number }> | undefined;
    if (checks) {
      for (const c of checks) {
        if (c.kind === 'int') out['type'] = 'integer';
        if (c.kind === 'min' && typeof c.value === 'number') out['minimum'] = c.value;
        if (c.kind === 'max' && typeof c.value === 'number') out['maximum'] = c.value;
      }
    }
    return out;
  }
  if (tn === 'ZodBoolean') return { type: 'boolean' };
  if (tn === 'ZodLiteral') return { const: def['value'] };
  if (tn === 'ZodEnum') return { type: 'string', enum: def['values'] };
  if (tn === 'ZodArray') {
    const out: Record<string, unknown> = {
      type: 'array',
      items: convert(def['type'] as ZodTypeAny),
    };
    if (typeof def['minLength'] === 'object' && def['minLength']) {
      out['minItems'] = (def['minLength'] as { value: number }).value;
    }
    if (typeof def['maxLength'] === 'object' && def['maxLength']) {
      out['maxItems'] = (def['maxLength'] as { value: number }).value;
    }
    return out;
  }
  if (tn === 'ZodObject') {
    const shape = (def['shape'] as () => Record<string, ZodTypeAny>)();
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      props[key] = convert(val);
      const valDef = (val as { _def: { typeName: string } })._def;
      if (valDef.typeName !== 'ZodOptional' && valDef.typeName !== 'ZodDefault') {
        required.push(key);
      }
    }
    const strict = def['unknownKeys'] === 'strict';
    const out: Record<string, unknown> = {
      type: 'object',
      properties: props,
      additionalProperties: !strict,
    };
    if (required.length > 0) out['required'] = required;
    return out;
  }
  if (tn === 'ZodUnion') {
    const opts = (def['options'] as ZodTypeAny[]).map(convert);
    return { anyOf: opts };
  }
  return { type: 'object' };
}

// Keep z import used (so ts doesn't trim).
export const __z = z;
