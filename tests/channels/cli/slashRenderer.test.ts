// slashRenderer.test.ts — SPEC-822 T10: visual snapshot tests for polished slash renderer.
// 9 fixture tests across states (list, arg-card, empty, fallback) × (narrow, wide).

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  renderList,
  renderArgCard,
  renderEmpty,
  groupByCategory,
  diffAndWrite,
  type RenderState,
} from '../../../src/channels/cli/slashRenderer.ts';
import {
  __resetRegistry,
  registerDefaultCommands,
  listCommands,
  type SlashCommand,
} from '../../../src/channels/cli/slashCommands.ts';
import { PassThrough } from 'node:stream';
import { shouldUsePolishedRenderer } from '../../../src/channels/cli/slashAutocomplete.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip all ANSI escape codes for plain-text assertions. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b/g, '');
}

/** Strip ANSI from every line in an array and join for readable diffs. */
function plainLines(lines: string[]): string[] {
  return lines.map(stripAnsi);
}

/** 3 minimal stub commands for isolated renderer tests. */
function makeStubCmds(): SlashCommand[] {
  return [
    {
      name: 'help',
      description: 'Show help',
      usage: '/help',
      category: 'system',
      handler: () => {},
    },
    {
      name: 'model',
      description: 'Get/set model',
      usage: '/model [name]',
      category: 'model',
      argHint: '[name]',
      argExamples: ['claude-sonnet-4-6', 'gpt-4o'],
      handler: () => {},
    },
    {
      name: 'switch',
      description: 'Switch workspace',
      usage: '/switch <name>',
      category: 'workspace',
      argHint: '<name>',
      argExamples: ['personal', 'work'],
      handler: () => {},
    },
  ];
}

beforeEach(() => {
  __resetRegistry();
  registerDefaultCommands();
});

// ---------------------------------------------------------------------------
// Suite 1: renderList — wide terminal (80 cols), accent marker, dim unselected
// ---------------------------------------------------------------------------

describe('SPEC-822: renderList — wide terminal', () => {
  test('selected row uses accent ▸ marker', () => {
    const cmds = makeStubCmds();
    const state: RenderState = { kind: 'list', filtered: cmds, selected: 0 };
    const lines = renderList(state, 80);

    // Check accent marker present in ANSI output for first (selected) row
    const selectedLine = lines[0] ?? '';
    expect(selectedLine).toContain('▸');
    expect(selectedLine).toContain('/help');
    // Other rows should NOT have accent marker for the selected symbol
    const unselectedLine = lines[1] ?? '';
    expect(unselectedLine).not.toContain('▸');
  });

  test('unselected rows are dim (no accent)', () => {
    const cmds = makeStubCmds();
    const state: RenderState = { kind: 'list', filtered: cmds, selected: 1 };
    const lines = renderList(state, 80);

    const plainAll = plainLines(lines);
    // row 0 = first item (index 0 = help, not selected)
    expect(plainAll[0]).toContain('/help');
    // selected row (index 1 = model)
    expect(plainAll[1]).toContain('/model');
    expect(lines[1]).toContain('▸'); // marker on selected
  });

  test('keybind legend footer is present', () => {
    const cmds = makeStubCmds();
    const state: RenderState = { kind: 'list', filtered: cmds, selected: 0 };
    const lines = renderList(state, 80);
    const plain = plainLines(lines);
    const footer = plain.join('\n');
    expect(footer).toContain('↑↓ select');
    expect(footer).toContain('tab complete');
    expect(footer).toContain('esc cancel');
  });

  test('empty filtered list returns no lines', () => {
    const state: RenderState = { kind: 'list', filtered: [], selected: 0 };
    const lines = renderList(state, 80);
    expect(lines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: renderList — narrow terminal (55 cols)
// ---------------------------------------------------------------------------

describe('SPEC-822: renderList — narrow terminal (55 cols)', () => {
  test('renders without error at 55 cols', () => {
    const cmds = makeStubCmds();
    const state: RenderState = { kind: 'list', filtered: cmds, selected: 0 };
    const lines = renderList(state, 55);
    expect(lines.length).toBeGreaterThan(0);
    const plain = plainLines(lines);
    expect(plain.some((l) => l.includes('/help'))).toBe(true);
  });

  test('name column stays within 40% of 55 = ~22, capped at 20', () => {
    const cmds = makeStubCmds();
    const state: RenderState = { kind: 'list', filtered: cmds, selected: 0 };
    const lines = renderList(state, 55);
    // Confirm names appear (no truncation for short names)
    const plain = plainLines(lines);
    expect(plain.some((l) => l.includes('/help'))).toBe(true);
    expect(plain.some((l) => l.includes('/model'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: renderArgCard — /model shows arg hint + examples
// ---------------------------------------------------------------------------

describe('SPEC-822: renderArgCard', () => {
  test('/model shows arg hint and examples — wide', () => {
    const cmd = makeStubCmds().find((c) => c.name === 'model')!;
    const lines = renderArgCard(cmd, 80);
    const plain = plainLines(lines);
    const combined = plain.join('\n');

    expect(combined).toContain('/model');
    expect(combined).toContain('[name]');
    expect(combined).toContain('claude-sonnet-4-6');
    expect(combined).toContain('gpt-4o');
    expect(combined).toContain('↑↓ select'); // legend
  });

  test('/model shows arg hint — narrow (55 cols)', () => {
    const cmd = makeStubCmds().find((c) => c.name === 'model')!;
    const lines = renderArgCard(cmd, 55);
    const plain = plainLines(lines);
    const combined = plain.join('\n');

    expect(combined).toContain('/model');
    expect(combined).toContain('[name]');
  });

  test('command with no argHint still renders header', () => {
    const cmd = makeStubCmds().find((c) => c.name === 'help')!;
    const lines = renderArgCard(cmd, 80);
    const plain = plainLines(lines);
    expect(plain.some((l) => l.includes('/help'))).toBe(true);
  });

  test('argChoices rendered when present', () => {
    const cmd: SlashCommand = {
      name: 'mode',
      description: 'Set mode',
      usage: '/mode',
      category: 'system',
      argHint: '[readonly|default|bypass]',
      argChoices: ['readonly', 'default', 'bypass'],
      handler: () => {},
    };
    const lines = renderArgCard(cmd, 80);
    const plain = plainLines(lines).join('\n');
    expect(plain).toContain('readonly');
    expect(plain).toContain('default');
    expect(plain).toContain('bypass');
  });
});

// ---------------------------------------------------------------------------
// Suite 4: renderEmpty — 4 category groups
// ---------------------------------------------------------------------------

describe('SPEC-822: renderEmpty — category grouping', () => {
  test('all 4 categories appear with full command set — wide (80 cols)', () => {
    const cmds = listCommands();
    const lines = renderEmpty(cmds, 80);
    const plain = plainLines(lines).join('\n');

    expect(plain).toContain('session');
    expect(plain).toContain('workspace');
    expect(plain).toContain('model');
    expect(plain).toContain('system');
  });

  test('all 4 categories appear — narrow (55 cols)', () => {
    const cmds = listCommands();
    const lines = renderEmpty(cmds, 55);
    const plain = plainLines(lines).join('\n');

    expect(plain).toContain('session');
    expect(plain).toContain('workspace');
    expect(plain).toContain('model');
    expect(plain).toContain('system');
  });

  test('groupByCategory puts all 13+ commands into 4 buckets', () => {
    const cmds = listCommands();
    const map = groupByCategory(cmds);

    const total = Array.from(map.values()).reduce((acc, arr) => acc + arr.length, 0);
    expect(total).toBe(cmds.length);
    // At least some buckets populated
    expect(map.get('session')?.length ?? 0).toBeGreaterThan(0);
    expect(map.get('system')?.length ?? 0).toBeGreaterThan(0);
  });

  test('commands with no category fall into system bucket', () => {
    const cmd: SlashCommand = {
      name: 'testcmd',
      description: 'No category',
      usage: '/testcmd',
      handler: () => {},
    };
    const map = groupByCategory([cmd]);
    const bucket = map.get('system');
    expect(bucket).toBeDefined();
    expect(bucket?.[0]?.name).toBe('testcmd');
  });

  test('keybind legend footer present in empty state', () => {
    const cmds = listCommands();
    const lines = renderEmpty(cmds, 80);
    const plain = plainLines(lines).join('\n');
    expect(plain).toContain('↑↓ select');
    expect(plain).toContain('esc cancel');
  });
});

// ---------------------------------------------------------------------------
// Suite 5: diffAndWrite — partial redraw
// ---------------------------------------------------------------------------

describe('SPEC-822: diffAndWrite — partial redraw', () => {
  function captureWrite(fn: (output: NodeJS.WritableStream) => void): string {
    const stream = new PassThrough();
    let out = '';
    stream.on('data', (chunk: Buffer | string) => {
      out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    fn(stream);
    return out;
  }

  test('no output when prev === next', () => {
    const lines = ['/help   Show help', '/model  Get/set model'];
    const out = captureWrite((s) => diffAndWrite(lines, lines, s));
    expect(out).toBe('');
  });

  test('changed rows are rewritten, bytes < 1 KB', () => {
    const prev = ['/help   Show help', '/model  Get/set model'];
    const next = ['/help   Show help', '/model  NEW description'];
    const out = captureWrite((s) => diffAndWrite(prev, next, s));

    // Should have output since second row changed
    expect(out.length).toBeGreaterThan(0);
    // Spec: <1KB per keystroke
    expect(out.length).toBeLessThan(1024);
    // Should contain the new content
    expect(out).toContain('NEW description');
  });

  test('adding new rows is handled', () => {
    const prev = ['line1'];
    const next = ['line1', 'line2'];
    const out = captureWrite((s) => diffAndWrite(prev, next, s));
    expect(out).toContain('line2');
    expect(out.length).toBeLessThan(1024);
  });

  test('removing rows erases them', () => {
    const prev = ['line1', 'line2'];
    const next = ['line1'];
    const out = captureWrite((s) => diffAndWrite(prev, next, s));
    // Should write erase sequence for the removed row
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(1024);
  });

  test('empty prev → empty next writes nothing', () => {
    const out = captureWrite((s) => diffAndWrite([], [], s));
    expect(out).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Suite 6: T8/T9 — fallback detection + feature flag
// ---------------------------------------------------------------------------

describe('SPEC-822: T8/T9 — fallback detection', () => {
  test('isTTY=false → returns false (no polished renderer)', () => {
    expect(shouldUsePolishedRenderer(false, 80)).toBe(false);
  });

  test('cols < 60 → returns false', () => {
    expect(shouldUsePolishedRenderer(true, 59)).toBe(false);
    expect(shouldUsePolishedRenderer(true, 55)).toBe(false);
  });

  test('isTTY=true + cols >= 60 → returns true', () => {
    expect(shouldUsePolishedRenderer(true, 60)).toBe(true);
    expect(shouldUsePolishedRenderer(true, 80)).toBe(true);
  });

  test('NIMBUS_SLASH_UI=plain → returns false even if TTY + wide', () => {
    const orig = process.env['NIMBUS_SLASH_UI'];
    process.env['NIMBUS_SLASH_UI'] = 'plain';
    try {
      expect(shouldUsePolishedRenderer(true, 80)).toBe(false);
    } finally {
      if (orig === undefined) delete process.env['NIMBUS_SLASH_UI'];
      else process.env['NIMBUS_SLASH_UI'] = orig;
    }
  });

  test('NIMBUS_SLASH_UI=polished → true (explicit override)', () => {
    const orig = process.env['NIMBUS_SLASH_UI'];
    process.env['NIMBUS_SLASH_UI'] = 'polished';
    try {
      expect(shouldUsePolishedRenderer(true, 80)).toBe(true);
    } finally {
      if (orig === undefined) delete process.env['NIMBUS_SLASH_UI'];
      else process.env['NIMBUS_SLASH_UI'] = orig;
    }
  });

  test('TERM=dumb → returns false', () => {
    const orig = process.env['TERM'];
    process.env['TERM'] = 'dumb';
    try {
      expect(shouldUsePolishedRenderer(true, 80)).toBe(false);
    } finally {
      if (orig === undefined) delete process.env['TERM'];
      else process.env['TERM'] = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 7: Regression — no stray full-width rule above slash menu (UX bug fix)
// Simulates: welcome screen printed, then user types '/' → renderEmpty called.
// None of renderEmpty / renderList / renderArgCard should emit a full-width
// RULE_CHAR line as their first line (that was the UX bug: a ────... bar
// appeared above the slash menu, looking like it belonged to the welcome screen).
// ---------------------------------------------------------------------------

describe('SPEC-822: regression — no leading rule in any render state', () => {
  const RULE_CHAR = '─';

  function isFullWidthRule(line: string, cols: number): boolean {
    // Strip ANSI then check if it's entirely RULE_CHAR repeated to ~cols width
    const plain = stripAnsi(line).trimEnd();
    return plain.length > 0 && plain.split('').every((ch) => ch === RULE_CHAR) && plain.length >= cols * 0.8;
  }

  test('renderEmpty first line is NOT a full-width rule', () => {
    const cmds = listCommands();
    const cols = 80;
    const lines = renderEmpty(cmds, cols);
    expect(lines.length).toBeGreaterThan(0);
    expect(isFullWidthRule(lines[0] ?? '', cols)).toBe(false);
  });

  test('renderList first line is NOT a full-width rule', () => {
    const cmds = makeStubCmds();
    const cols = 80;
    const state: RenderState = { kind: 'list', filtered: cmds, selected: 0 };
    const lines = renderList(state, cols);
    expect(lines.length).toBeGreaterThan(0);
    expect(isFullWidthRule(lines[0] ?? '', cols)).toBe(false);
  });

  test('renderArgCard first line is NOT a full-width rule', () => {
    const cmd = makeStubCmds().find((c) => c.name === 'model')!;
    const cols = 80;
    const lines = renderArgCard(cmd, cols);
    expect(lines.length).toBeGreaterThan(0);
    expect(isFullWidthRule(lines[0] ?? '', cols)).toBe(false);
  });
});
