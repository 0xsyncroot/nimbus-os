// tests/platform/detect.test.ts (SPEC-151 §6.1)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __resetDetectCache, detect, PlatformCapsSchema } from '../../src/platform/detect.ts';

const originalShell = process.env['SHELL'];
const originalNimbusShell = process.env['NIMBUS_SHELL'];
const originalWslDistro = process.env['WSL_DISTRO_NAME'];
const originalForceColor = process.env['FORCE_COLOR'];
const originalNoColor = process.env['NO_COLOR'];

describe('SPEC-151: detect', () => {
  beforeEach(() => {
    __resetDetectCache();
    delete process.env['NIMBUS_SHELL'];
    delete process.env['WSL_DISTRO_NAME'];
    delete process.env['NO_COLOR'];
    delete process.env['FORCE_COLOR'];
  });
  afterEach(() => {
    if (originalShell !== undefined) process.env['SHELL'] = originalShell;
    if (originalNimbusShell !== undefined) process.env['NIMBUS_SHELL'] = originalNimbusShell;
    if (originalWslDistro !== undefined) process.env['WSL_DISTRO_NAME'] = originalWslDistro;
    if (originalForceColor !== undefined) process.env['FORCE_COLOR'] = originalForceColor;
    if (originalNoColor !== undefined) process.env['NO_COLOR'] = originalNoColor;
    __resetDetectCache();
  });

  test('returns caps that match schema', () => {
    const caps = detect();
    const parsed = PlatformCapsSchema.safeParse(caps);
    expect(parsed.success).toBe(true);
  });

  test('memoizes result', () => {
    const a = detect();
    const b = detect();
    expect(a).toBe(b);
  });

  test('NIMBUS_SHELL override wins', () => {
    process.env['NIMBUS_SHELL'] = 'bash';
    __resetDetectCache();
    expect(detect().defaultShell).toBe('bash');
  });

  test('WSL_DISTRO_NAME forces isWSL true on linux', () => {
    if (process.platform !== 'linux') return;
    process.env['WSL_DISTRO_NAME'] = 'Ubuntu-22.04';
    __resetDetectCache();
    expect(detect().isWSL).toBe(true);
  });

  test('NO_COLOR disables color', () => {
    process.env['NO_COLOR'] = '1';
    __resetDetectCache();
    expect(detect().hasColor).toBe(false);
  });

  test('lineEnding matches platform convention', () => {
    const caps = detect();
    if (caps.os === 'win32') expect(caps.lineEnding).toBe('\r\n');
    else expect(caps.lineEnding).toBe('\n');
  });
});
