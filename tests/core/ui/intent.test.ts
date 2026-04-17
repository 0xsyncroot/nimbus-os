// intent.test.ts — SPEC-830: UIIntent Zod schema validation + exhaustiveness helper.

import { describe, expect, test } from 'bun:test';
import {
  uiIntentSchema,
  uiIntentConfirmSchema,
  uiIntentPickSchema,
  uiIntentInputSchema,
  uiIntentStatusSchema,
  assertExhaustiveIntent,
  type UIIntent,
  type UIResult,
} from '../../../src/core/ui/intent.ts';

describe('SPEC-830: UIIntent schemas', () => {
  // -------------------------------------------------------------------------
  // confirm
  // -------------------------------------------------------------------------
  test('confirm — valid minimal payload', () => {
    const result = uiIntentConfirmSchema.safeParse({ kind: 'confirm', prompt: 'Continue?' });
    expect(result.success).toBe(true);
  });

  test('confirm — valid full payload', () => {
    const result = uiIntentConfirmSchema.safeParse({
      kind: 'confirm',
      prompt: 'Apply changes?',
      defaultValue: false,
      timeoutMs: 30000,
    });
    expect(result.success).toBe(true);
  });

  test('confirm — rejects empty prompt', () => {
    const result = uiIntentConfirmSchema.safeParse({ kind: 'confirm', prompt: '' });
    expect(result.success).toBe(false);
  });

  test('confirm — rejects negative timeoutMs', () => {
    const result = uiIntentConfirmSchema.safeParse({
      kind: 'confirm',
      prompt: 'ok?',
      timeoutMs: -1,
    });
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // pick
  // -------------------------------------------------------------------------
  test('pick — valid payload', () => {
    const result = uiIntentPickSchema.safeParse({
      kind: 'pick',
      prompt: 'Choose model:',
      options: [
        { id: 'opus', label: 'Claude Opus', hint: 'Most capable' },
        { id: 'sonnet', label: 'Claude Sonnet' },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('pick — rejects empty options array', () => {
    const result = uiIntentPickSchema.safeParse({ kind: 'pick', prompt: 'Choose:', options: [] });
    expect(result.success).toBe(false);
  });

  test('pick — rejects option with empty id', () => {
    const result = uiIntentPickSchema.safeParse({
      kind: 'pick',
      prompt: 'Choose:',
      options: [{ id: '', label: 'Bad' }],
    });
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // input
  // -------------------------------------------------------------------------
  test('input — valid minimal payload', () => {
    const result = uiIntentInputSchema.safeParse({ kind: 'input', prompt: 'API key:' });
    expect(result.success).toBe(true);
  });

  test('input — valid secret payload', () => {
    const result = uiIntentInputSchema.safeParse({
      kind: 'input',
      prompt: 'Password:',
      secret: true,
      placeholder: '••••••',
    });
    expect(result.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------
  test('status — valid info payload', () => {
    const result = uiIntentStatusSchema.safeParse({
      kind: 'status',
      message: 'Loading...',
      level: 'info',
    });
    expect(result.success).toBe(true);
  });

  test('status — rejects invalid level', () => {
    const result = uiIntentStatusSchema.safeParse({
      kind: 'status',
      message: 'Loading...',
      level: 'debug',
    });
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // discriminated union
  // -------------------------------------------------------------------------
  test('uiIntentSchema — routes each kind correctly', () => {
    const kinds: UIIntent['kind'][] = ['confirm', 'pick', 'input', 'status'];
    const payloads: UIIntent[] = [
      { kind: 'confirm', prompt: 'Yes?' },
      { kind: 'pick', prompt: 'Pick one:', options: [{ id: 'a', label: 'A' }] },
      { kind: 'input', prompt: 'Enter text:' },
      { kind: 'status', message: 'Done', level: 'info' },
    ];
    for (let i = 0; i < payloads.length; i++) {
      const r = uiIntentSchema.safeParse(payloads[i]);
      expect(r.success).toBe(true);
      const expected = kinds[i];
      if (r.success && expected !== undefined) expect(r.data.kind).toBe(expected);
    }
  });

  test('uiIntentSchema — rejects unknown kind', () => {
    const result = uiIntentSchema.safeParse({ kind: 'unknown', prompt: 'x' });
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // UIResult type round-trip (compile-time check via usage below)
  // -------------------------------------------------------------------------
  test('UIResult ok shape is assignable', () => {
    const r: UIResult<boolean> = { kind: 'ok', value: true };
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toBe(true);
  });

  test('UIResult cancel shape is assignable', () => {
    const r: UIResult<string> = { kind: 'cancel' };
    expect(r.kind).toBe('cancel');
  });

  test('UIResult timeout shape is assignable', () => {
    const r: UIResult<number> = { kind: 'timeout' };
    expect(r.kind).toBe('timeout');
  });

  // -------------------------------------------------------------------------
  // assertExhaustiveIntent — throws for unhandled kind at runtime
  // -------------------------------------------------------------------------
  test('assertExhaustiveIntent — throws with the bad kind in message', () => {
    expect(() => assertExhaustiveIntent({ kind: 'bogus' } as never)).toThrow('bogus');
  });
});
