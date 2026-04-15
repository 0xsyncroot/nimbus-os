// tests/platform/paths.test.ts (SPEC-151 §6.1)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cacheDir, configDir, dataDir, logsDir, nimbusHome, workspacesDir } from '../../src/platform/paths.ts';
import { __resetDetectCache } from '../../src/platform/detect.ts';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';

const originalHome = process.env['NIMBUS_HOME'];

describe('SPEC-151: paths', () => {
  beforeEach(() => {
    delete process.env['NIMBUS_HOME'];
    __resetDetectCache();
  });
  afterEach(() => {
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
    __resetDetectCache();
  });

  test('NIMBUS_HOME override applied to all dirs', () => {
    process.env['NIMBUS_HOME'] = '/tmp/nimbus-override';
    expect(nimbusHome()).toBe('/tmp/nimbus-override');
    expect(configDir().startsWith('/tmp/nimbus-override')).toBe(true);
    expect(cacheDir().startsWith('/tmp/nimbus-override')).toBe(true);
    expect(dataDir().startsWith('/tmp/nimbus-override')).toBe(true);
    expect(logsDir().startsWith('/tmp/nimbus-override')).toBe(true);
    expect(workspacesDir().startsWith('/tmp/nimbus-override')).toBe(true);
  });

  test('rejects non-absolute NIMBUS_HOME', () => {
    process.env['NIMBUS_HOME'] = 'relative/path';
    try {
      nimbusHome();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.X_PATH_BLOCKED);
    }
  });

  test('rejects traversal in NIMBUS_HOME', () => {
    process.env['NIMBUS_HOME'] = '/tmp/foo/../evil';
    try {
      nimbusHome();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.X_PATH_BLOCKED);
    }
  });

  test('Linux configDir respects XDG_CONFIG_HOME', () => {
    if (process.platform !== 'linux') return;
    const prev = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = '/tmp/xdg-cfg';
    try {
      expect(configDir()).toBe('/tmp/xdg-cfg/nimbus');
    } finally {
      if (prev !== undefined) process.env['XDG_CONFIG_HOME'] = prev;
      else delete process.env['XDG_CONFIG_HOME'];
    }
  });

  test('workspacesDir nested under dataDir', () => {
    expect(workspacesDir().startsWith(dataDir())).toBe(true);
    expect(workspacesDir().endsWith('workspaces')).toBe(true);
  });
});
