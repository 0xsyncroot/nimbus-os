import { describe, expect, test } from 'bun:test';
import { createDefaultRegistry, createLoopAdapter } from '../../../src/tools/index.ts';
import { compileRules, createGate } from '../../../src/permissions/index.ts';

describe('SPEC-801/Task-25: REPL tools wiring', () => {
  test('adapter exposes listTools from default registry', () => {
    const registry = createDefaultRegistry({ includeBash: true, includeMemory: true });
    const gate = createGate({ rules: compileRules([]) });
    const adapter = createLoopAdapter({
      registry,
      permissions: gate,
      workspaceId: 'ws1',
      sessionId: 'sess1',
      cwd: process.cwd(),
      mode: 'default',
    });
    const names = adapter.listTools().map((t) => t.name).sort();
    for (const expected of ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'Memory']) {
      expect(names).toContain(expected);
    }
  });

  test('effectOf classifies tools', () => {
    const registry = createDefaultRegistry({ includeBash: true });
    const gate = createGate({ rules: compileRules([]) });
    const adapter = createLoopAdapter({
      registry, permissions: gate, workspaceId: 'w', sessionId: 's',
      cwd: process.cwd(), mode: 'default',
    });
    expect(adapter.effectOf('Read')).toBe('read');
    expect(adapter.effectOf('Grep')).toBe('read');
    expect(adapter.effectOf('Write')).toBe('write');
    expect(adapter.effectOf('Bash')).toBe('exec');
  });
});
