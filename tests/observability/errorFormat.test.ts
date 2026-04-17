// errorFormat.test.ts — SPEC-901 v0.2.1: human-readable error format tests
import { describe, expect, test } from 'bun:test';
import { formatError } from '../../src/observability/errorFormat.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';

describe('SPEC-901 v0.2.1: formatError', () => {
  test('U_MISSING_CONFIG missing_passphrase → passphrase hint', () => {
    const err = new NimbusError(ErrorCode.U_MISSING_CONFIG, { reason: 'missing_passphrase' });
    const { summary, action } = formatError(err);
    expect(summary).toContain('passphrase');
    expect(action).toContain('NIMBUS_VAULT_PASSPHRASE');
  });

  test('U_MISSING_CONFIG no_active_workspace → init hint', () => {
    const err = new NimbusError(ErrorCode.U_MISSING_CONFIG, { reason: 'no_active_workspace' });
    const { summary, action } = formatError(err);
    expect(summary).toContain('workspace');
    expect(action).toContain('nimbus init');
  });

  test('U_MISSING_CONFIG generic → config hint', () => {
    const err = new NimbusError(ErrorCode.U_MISSING_CONFIG, { reason: 'other' });
    const { summary, action } = formatError(err);
    expect(summary).toBeTruthy();
    expect(action).toContain('nimbus init');
  });

  test('P_AUTH → key invalid message', () => {
    const err = new NimbusError(ErrorCode.P_AUTH, {});
    const { summary, action } = formatError(err);
    expect(summary).toContain('API key');
    expect(action).toContain('nimbus key set');
  });

  test('P_NETWORK → connection message', () => {
    const err = new NimbusError(ErrorCode.P_NETWORK, {});
    const { summary, action } = formatError(err);
    expect(summary).toContain('Network');
    expect(action).toContain('internet');
  });

  test('P_429 → rate limit message', () => {
    const err = new NimbusError(ErrorCode.P_429, {});
    const { summary, action } = formatError(err);
    expect(summary).toContain('Rate');
    expect(action).toBeTruthy();
  });

  test('P_5XX → server error message', () => {
    const err = new NimbusError(ErrorCode.P_5XX, {});
    const { summary, action } = formatError(err);
    expect(summary).toContain('server error');
    expect(action).toContain('temporary');
  });

  test('P_CONTEXT_OVERFLOW → context too long', () => {
    const err = new NimbusError(ErrorCode.P_CONTEXT_OVERFLOW, {});
    const { summary, action } = formatError(err);
    expect(summary).toContain('long');
    expect(action).toContain('new session');
  });

  test('P_MODEL_NOT_FOUND → includes model name', () => {
    const err = new NimbusError(ErrorCode.P_MODEL_NOT_FOUND, { model: 'gpt-9000' });
    const { summary, action } = formatError(err);
    expect(summary).toContain('gpt-9000');
    expect(action).toContain('nimbus init');
  });

  test('T_PERMISSION → blocked message', () => {
    const err = new NimbusError(ErrorCode.T_PERMISSION, {});
    const { summary, action } = formatError(err);
    expect(summary).toContain('blocked');
    expect(action).toBeTruthy();
  });

  test('T_NOT_FOUND → includes path if provided', () => {
    const err = new NimbusError(ErrorCode.T_NOT_FOUND, { path: '/etc/shadow' });
    const { summary, action } = formatError(err);
    expect(summary).toContain('/etc/shadow');
    expect(action).toBeTruthy();
  });

  test('X_BASH_BLOCKED → safety rules message', () => {
    const err = new NimbusError(ErrorCode.X_BASH_BLOCKED, {});
    const { summary, action } = formatError(err);
    expect(summary).toContain('blocked');
    expect(action).toBeTruthy();
  });

  test('X_CRED_ACCESS → credential access message with key set action', () => {
    const err = new NimbusError(ErrorCode.X_CRED_ACCESS, {});
    const { summary, action } = formatError(err);
    expect(summary).toContain('Credential');
    expect(action).toContain('nimbus key set');
  });

  test('S_CONFIG_INVALID unknown_secrets_backend → backend hint', () => {
    const err = new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'unknown_secrets_backend',
      value: 'foobar',
    });
    const { summary, action } = formatError(err);
    expect(summary).toContain('foobar');
    expect(action).toContain('NIMBUS_SECRETS_BACKEND');
  });

  test('U_BAD_COMMAND workspace_exists → force hint', () => {
    const err = new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'workspace_exists',
      name: 'my-ws',
    });
    const { summary, action } = formatError(err);
    expect(summary).toContain('my-ws');
    expect(action).toContain('--force');
  });

  test('known code Y_OOM returns non-empty summary and action', () => {
    // SPEC-852: Y_OOM now has an explicit mapping; fallback path still covered by default branch.
    const err = new NimbusError(ErrorCode.Y_OOM, {});
    const { summary, action } = formatError(err);
    expect(summary).toBeTruthy();
    expect(action).toBeTruthy();
  });

  test('formatError returns exactly {summary, action} shape', () => {
    const err = new NimbusError(ErrorCode.P_AUTH, {});
    const result = formatError(err);
    expect(typeof result.summary).toBe('string');
    expect(typeof result.action).toBe('string');
    expect(Object.keys(result)).toHaveLength(2);
  });
});
