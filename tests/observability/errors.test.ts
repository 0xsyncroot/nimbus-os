// errors.test.ts — META-012: unit tests for UI error codes
import { describe, expect, test } from 'bun:test';
import { ErrorCode, NimbusError, classify } from '../../src/observability/errors.ts';
import { formatError } from '../../src/observability/errorFormat.ts';

describe('META-012: UI error codes — enum values exist', () => {
  test('U_UI_BUSY enum value is stable string key', () => {
    // Cast to string to avoid the bun:test matcher overload constraint on enum literals
    expect(ErrorCode.U_UI_BUSY as string).toBe('U_UI_BUSY');
  });

  test('U_UI_CANCELLED enum value is stable string key', () => {
    expect(ErrorCode.U_UI_CANCELLED as string).toBe('U_UI_CANCELLED');
  });

  test('P_KEYBIND_RESERVED enum value is stable string key', () => {
    expect(ErrorCode.P_KEYBIND_RESERVED as string).toBe('P_KEYBIND_RESERVED');
  });

  test('P_OPERATION_DENIED enum value is stable string key', () => {
    expect(ErrorCode.P_OPERATION_DENIED as string).toBe('P_OPERATION_DENIED');
  });
});

describe('META-012: NimbusError retryable / userFacing properties', () => {
  test('U_UI_BUSY — retryable=false, userFacing=true', () => {
    const err = new NimbusError(ErrorCode.U_UI_BUSY, {});
    expect(err.retryable).toBe(false);
    expect(err.userFacing).toBe(true);
  });

  test('U_UI_CANCELLED — retryable=false, userFacing=false', () => {
    const err = new NimbusError(ErrorCode.U_UI_CANCELLED, {});
    expect(err.retryable).toBe(false);
    expect(err.userFacing).toBe(false);
  });

  test('P_KEYBIND_RESERVED — retryable=false, userFacing=true', () => {
    const err = new NimbusError(ErrorCode.P_KEYBIND_RESERVED, { key: 'ctrl+c' });
    expect(err.retryable).toBe(false);
    expect(err.userFacing).toBe(true);
  });

  test('P_OPERATION_DENIED — retryable=false, userFacing=true', () => {
    const err = new NimbusError(ErrorCode.P_OPERATION_DENIED, { reason: 'alt_screen_active' });
    expect(err.retryable).toBe(false);
    expect(err.userFacing).toBe(true);
  });
});

describe('META-012: classify() round-trip for new codes', () => {
  test('classify(NimbusError(U_UI_BUSY)) returns U_UI_BUSY', () => {
    const err = new NimbusError(ErrorCode.U_UI_BUSY, {});
    expect(classify(err)).toBe(ErrorCode.U_UI_BUSY);
  });

  test('classify(NimbusError(U_UI_CANCELLED)) returns U_UI_CANCELLED', () => {
    const err = new NimbusError(ErrorCode.U_UI_CANCELLED, {});
    expect(classify(err)).toBe(ErrorCode.U_UI_CANCELLED);
  });

  test('classify(NimbusError(P_KEYBIND_RESERVED)) returns P_KEYBIND_RESERVED', () => {
    const err = new NimbusError(ErrorCode.P_KEYBIND_RESERVED, { key: 'ctrl+c' });
    expect(classify(err)).toBe(ErrorCode.P_KEYBIND_RESERVED);
  });

  test('classify(NimbusError(P_OPERATION_DENIED)) returns P_OPERATION_DENIED', () => {
    const err = new NimbusError(ErrorCode.P_OPERATION_DENIED, { reason: 'alt_screen_active' });
    expect(classify(err)).toBe(ErrorCode.P_OPERATION_DENIED);
  });
});

describe('META-012: formatError messages — EN', () => {
  test('U_UI_BUSY — summary mentions busy, action mentions wait', () => {
    const err = new NimbusError(ErrorCode.U_UI_BUSY, {});
    const { summary, action } = formatError(err);
    expect(summary.toLowerCase()).toContain('busy');
    expect(action.toLowerCase()).toContain('wait');
  });

  test('U_UI_CANCELLED — summary says cancelled, action is empty', () => {
    const err = new NimbusError(ErrorCode.U_UI_CANCELLED, {});
    const { summary, action } = formatError(err);
    expect(summary.toLowerCase()).toContain('cancel');
    expect(action).toBe('');
  });

  test('P_KEYBIND_RESERVED — summary mentions reserved, action includes key name', () => {
    const err = new NimbusError(ErrorCode.P_KEYBIND_RESERVED, { key: 'ctrl+c' });
    const { summary, action } = formatError(err);
    expect(summary.toLowerCase()).toContain('reserved');
    expect(action).toContain('ctrl+c');
  });

  test('P_KEYBIND_RESERVED — fallback when key not provided', () => {
    const err = new NimbusError(ErrorCode.P_KEYBIND_RESERVED, {});
    const { summary, action } = formatError(err);
    expect(summary.toLowerCase()).toContain('reserved');
    expect(action).toContain('that key');
  });

  test('P_OPERATION_DENIED — summary says not allowed, action includes reason', () => {
    const err = new NimbusError(ErrorCode.P_OPERATION_DENIED, { reason: 'alt_screen_active' });
    const { summary, action } = formatError(err);
    expect(summary.toLowerCase()).toContain('not allowed');
    expect(action).toContain('alt_screen_active');
  });

  test('P_OPERATION_DENIED — fallback when reason not provided', () => {
    const err = new NimbusError(ErrorCode.P_OPERATION_DENIED, {});
    const { summary, action } = formatError(err);
    expect(summary.toLowerCase()).toContain('not allowed');
    expect(action).toBeTruthy();
  });
});

describe('META-012: NimbusError.toJSON includes new codes', () => {
  test('toJSON shape preserved for P_KEYBIND_RESERVED', () => {
    const err = new NimbusError(ErrorCode.P_KEYBIND_RESERVED, { key: 'ctrl+c' });
    const json = err.toJSON();
    expect(json['code']).toBe('P_KEYBIND_RESERVED');
    expect(json['context']).toEqual({ key: 'ctrl+c' });
  });
});
