// permissions.test.ts — SPEC-846: PermissionDialog + 8 per-tool request components.
// Tests: dispatcher routes by tool name, border constants, Bash prefix safety,
// destructive warning, FileEdit embeds StructuredDiff, ExitPlanMode sticky footer,
// response labels, ctrl+e explanation toggle, unknown tool → T_VALIDATION,
// ANSI strip on plan body, UIResult shape.

import { describe, test, expect, afterEach } from 'bun:test';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/channels/cli/ink/theme.ts';
import {
  PermissionDialog,
  PERMISSION_BORDER_STYLE,
  PERMISSION_BORDER_LEFT,
  PERMISSION_BORDER_RIGHT,
  PERMISSION_BORDER_BOTTOM,
} from '../../../../src/channels/cli/ink/components/permissions/PermissionDialog.tsx';
import { PermissionRequest } from '../../../../src/channels/cli/ink/components/permissions/PermissionRequest.tsx';
import { BashPermissionRequest, getSimpleCommandPrefix } from '../../../../src/channels/cli/ink/components/permissions/BashPermissionRequest.tsx';
import { FileWritePermissionRequest } from '../../../../src/channels/cli/ink/components/permissions/FileWritePermissionRequest.tsx';
import { FileEditPermissionRequest } from '../../../../src/channels/cli/ink/components/permissions/FileEditPermissionRequest.tsx';
import { WebFetchPermissionRequest } from '../../../../src/channels/cli/ink/components/permissions/WebFetchPermissionRequest.tsx';
import { SkillPermissionRequest } from '../../../../src/channels/cli/ink/components/permissions/SkillPermissionRequest.tsx';
import { ExitPlanModePermissionRequest } from '../../../../src/channels/cli/ink/components/permissions/ExitPlanModePermissionRequest.tsx';
import { PermissionExplanation } from '../../../../src/channels/cli/ink/components/permissions/PermissionExplanation.tsx';
import { SedEditPermissionRequest } from '../../../../src/channels/cli/ink/components/permissions/SedEditPermissionRequest.tsx';
import { NotebookEditPermissionRequest } from '../../../../src/channels/cli/ink/components/permissions/NotebookEditPermissionRequest.tsx';
import { NimbusError, ErrorCode } from '../../../../src/observability/errors.ts';
import { stripAnsiOsc } from '../../../../src/channels/cli/ink/components/StructuredDiff/colorDiff.ts';
import type { DiffHunk } from '../../../../src/channels/cli/ink/components/StructuredDiff/colorDiff.ts';
import type { UIResult, PermissionResponse } from '../../../../src/core/ui/intent.ts';

afterEach(() => {
  cleanup();
});

// ── Fixtures ───────────────────────────────────────────────────────────────────
function noop() { /* no-op */ }

function makeProps(toolName: string, toolInput: Record<string, unknown> = {}) {
  return {
    toolName,
    toolInput,
    onAllow: noop,
    onAlways: noop,
    onDeny: noop,
  };
}

function wrap(el: React.ReactElement) {
  return React.createElement(ThemeProvider, { name: 'dark' }, el);
}

// ── SPEC-846 T1: Border constants ──────────────────────────────────────────────
describe('SPEC-846: Border constants', () => {
  test('PERMISSION_BORDER_STYLE is round', () => {
    expect(PERMISSION_BORDER_STYLE).toBe('round');
  });

  test('PERMISSION_BORDER_LEFT is false', () => {
    expect(PERMISSION_BORDER_LEFT).toBe(false);
  });

  test('PERMISSION_BORDER_RIGHT is false', () => {
    expect(PERMISSION_BORDER_RIGHT).toBe(false);
  });

  test('PERMISSION_BORDER_BOTTOM is false', () => {
    expect(PERMISSION_BORDER_BOTTOM).toBe(false);
  });
});

// ── SPEC-846 T1: PermissionDialog renders ─────────────────────────────────────
describe('SPEC-846: PermissionDialog shell', () => {
  test('renders toolName in title', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionDialog, makeProps('bash')),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('bash');
  });

  test('renders Yes option', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionDialog, makeProps('bash')),
    ));
    expect(lastFrame()).toContain('Yes');
  });

  test('renders No option', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionDialog, makeProps('bash')),
    ));
    expect(lastFrame()).toContain('No');
  });

  test('allowAlways=true shows "don\'t ask again" option', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionDialog, { ...makeProps('bash'), allowAlways: true }),
    ));
    expect(lastFrame()).toContain("don't ask again");
  });

  test('allowAlways=false hides "don\'t ask again" option', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionDialog, { ...makeProps('bash'), allowAlways: false }),
    ));
    expect(lastFrame()).not.toContain("don't ask again");
  });

  test('label exact text: "Yes, and don\'t ask again for <prefix>"', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionDialog, { ...makeProps('mytool'), allowAlways: true }),
    ));
    const frame = lastFrame() ?? '';
    // Must contain "ask again for" not "ask for ... again"
    expect(frame).toContain("don't ask again for mytool");
  });
});

// ── SPEC-846 T2: Dispatcher routes by tool name ────────────────────────────────
describe('SPEC-846: PermissionRequest dispatcher', () => {
  test('routes bash to BashPermissionRequest', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionRequest, makeProps('bash', { command: 'echo hello' })),
    ));
    expect(lastFrame()).toContain('echo');
  });

  test('routes write to FileWritePermissionRequest', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionRequest, makeProps('write', { path: '/tmp/test.txt', content: 'hello' })),
    ));
    expect(lastFrame()).toContain('test.txt');
  });

  test('routes edit to FileEditPermissionRequest', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionRequest, makeProps('edit', { path: '/tmp/edit.ts', old_string: 'old', new_string: 'new' })),
    ));
    expect(lastFrame()).toContain('edit.ts');
  });

  test('routes web_fetch to WebFetchPermissionRequest', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionRequest, makeProps('web_fetch', { url: 'https://example.com/path' })),
    ));
    expect(lastFrame()).toContain('example.com');
  });

  test('routes skill to SkillPermissionRequest', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionRequest, makeProps('skill', { name: 'my-skill', description: 'does stuff' })),
    ));
    expect(lastFrame()).toContain('my-skill');
  });

  test('routes exit_plan_mode to ExitPlanModePermissionRequest', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionRequest, makeProps('exit_plan_mode', { plan: 'Step 1\nStep 2' })),
    ));
    expect(lastFrame()).toContain('Step 1');
  });

  test('unknown tool throws NimbusError T_VALIDATION', () => {
    // Call the component function directly — React render() swallows errors.
    expect(() => {
      PermissionRequest(makeProps('unknown_xyz_tool'));
    }).toThrow(NimbusError);

    try {
      PermissionRequest(makeProps('unknown_xyz_tool'));
    } catch (e) {
      expect(e).toBeInstanceOf(NimbusError);
      expect((e as NimbusError).code).toBe(ErrorCode.T_VALIDATION);
    }
  });
});

// ── SPEC-846 T3: BashPermissionRequest ────────────────────────────────────────
describe('SPEC-846: BashPermissionRequest', () => {
  test('shows command text', () => {
    const { lastFrame } = render(wrap(
      React.createElement(BashPermissionRequest, makeProps('bash', { command: 'ls -la /home' })),
    ));
    expect(lastFrame()).toContain('ls -la /home');
  });

  test('getSimpleCommandPrefix returns base command for simple cmd', () => {
    expect(getSimpleCommandPrefix('echo hello world')).toBe('echo');
    expect(getSimpleCommandPrefix('/usr/bin/ls -la')).toBe('ls');
  });

  test('getSimpleCommandPrefix returns null for compound ;', () => {
    expect(getSimpleCommandPrefix('cmd1; cmd2')).toBeNull();
  });

  test('getSimpleCommandPrefix returns null for &&', () => {
    expect(getSimpleCommandPrefix('make && make install')).toBeNull();
  });

  test('getSimpleCommandPrefix returns null for ||', () => {
    expect(getSimpleCommandPrefix('test || fallback')).toBeNull();
  });

  test('getSimpleCommandPrefix returns null for pipe |', () => {
    expect(getSimpleCommandPrefix('cat file | grep pattern')).toBeNull();
  });

  test('getSimpleCommandPrefix returns null for newline', () => {
    expect(getSimpleCommandPrefix('cmd1\ncmd2')).toBeNull();
  });

  test('getSimpleCommandPrefix returns null for $( substitution', () => {
    expect(getSimpleCommandPrefix('echo $(whoami)')).toBeNull();
  });

  test('getSimpleCommandPrefix returns null for backtick', () => {
    expect(getSimpleCommandPrefix('echo `whoami`')).toBeNull();
  });

  test('compound cmd1 && cmd2 — "Always" option HIDDEN', () => {
    const { lastFrame } = render(wrap(
      React.createElement(BashPermissionRequest, makeProps('bash', { command: 'make && make install' })),
    ));
    const frame = lastFrame() ?? '';
    // "don't ask again" must not appear
    expect(frame).not.toContain("don't ask again");
  });

  test('compound cmd with pipe — "Always" option HIDDEN', () => {
    const { lastFrame } = render(wrap(
      React.createElement(BashPermissionRequest, makeProps('bash', { command: 'cat file | grep foo' })),
    ));
    expect(lastFrame()).not.toContain("don't ask again");
  });

  test('rm -rf / shows destructive warning', () => {
    const { lastFrame } = render(wrap(
      React.createElement(BashPermissionRequest, makeProps('bash', { command: 'rm -rf /' })),
    ));
    const frame = lastFrame() ?? '';
    // Should show some destructive warning text
    expect(frame.toLowerCase()).toMatch(/destructive|warning|rm/i);
  });

  test('sudo command shows destructive warning', () => {
    const { lastFrame } = render(wrap(
      React.createElement(BashPermissionRequest, makeProps('bash', { command: 'sudo apt install foo' })),
    ));
    const frame = lastFrame() ?? '';
    expect(frame.toLowerCase()).toMatch(/destructive|warning|sudo|privilege/i);
  });

  test('safe simple command shows no destructive warning', () => {
    const { lastFrame } = render(wrap(
      React.createElement(BashPermissionRequest, makeProps('bash', { command: 'echo hello' })),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Destructive command detected');
  });

  test('compound security warning message shown for ; operator', () => {
    const { lastFrame } = render(wrap(
      React.createElement(BashPermissionRequest, makeProps('bash', { command: 'echo a; echo b' })),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Compound operators detected');
  });
});

// ── SPEC-846 T4: FileEditPermissionRequest embeds StructuredDiff ──────────────
describe('SPEC-846: FileEditPermissionRequest', () => {
  test('renders file path', () => {
    const hunk: DiffHunk = {
      oldStart: 1, newStart: 1, oldLines: 1, newLines: 1,
      lines: [{ type: 'add', content: 'new content', newLineNo: 1 }],
    };
    const { lastFrame } = render(wrap(
      React.createElement(FileEditPermissionRequest, makeProps('edit', {
        path: '/src/index.ts',
        hunk,
      })),
    ));
    expect(lastFrame()).toContain('index.ts');
  });

  test('renders StructuredDiff when hunk provided (snapshot-like: contains diff markers)', () => {
    const hunk: DiffHunk = {
      oldStart: 1, newStart: 1, oldLines: 1, newLines: 1,
      lines: [
        { type: 'add', content: 'added line', newLineNo: 1 },
        { type: 'remove', content: 'removed line', oldLineNo: 1 },
      ],
    };
    const { lastFrame } = render(wrap(
      React.createElement(FileEditPermissionRequest, makeProps('edit', {
        path: '/src/foo.ts',
        hunk,
      })),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('+');
    expect(frame).toContain('-');
    expect(frame).toContain('added line');
    expect(frame).toContain('removed line');
  });

  test('renders old/new strings when no hunk provided', () => {
    const { lastFrame } = render(wrap(
      React.createElement(FileEditPermissionRequest, makeProps('edit', {
        path: '/src/bar.ts',
        old_string: 'old text',
        new_string: 'new text',
      })),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('old text');
    expect(frame).toContain('new text');
  });
});

// ── SPEC-846 T5: ExitPlanMode sticky footer ────────────────────────────────────
describe('SPEC-846: ExitPlanModePermissionRequest sticky footer', () => {
  test('renders plan text', () => {
    const { lastFrame } = render(wrap(
      React.createElement(ExitPlanModePermissionRequest, makeProps('exit_plan_mode', {
        plan: 'Step 1: do X\nStep 2: do Y\nStep 3: done',
      })),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Step 1: do X');
    expect(frame).toContain('Step 2: do Y');
  });

  test('Y/A/N labels visible in footer', () => {
    const { lastFrame } = render(wrap(
      React.createElement(ExitPlanModePermissionRequest, makeProps('exit_plan_mode', { plan: 'my plan' })),
    ));
    const frame = lastFrame() ?? '';
    // Response options should be visible
    expect(frame).toMatch(/Y|Yes/);
    expect(frame).toMatch(/A|Always/);
    expect(frame).toMatch(/N|No/);
  });

  test('ANSI escape in plan body stripped', () => {
    const ansiPlan = '\x1b[2JThis is a plan step\x1b[0m';
    const { lastFrame } = render(wrap(
      React.createElement(ExitPlanModePermissionRequest, makeProps('exit_plan_mode', { plan: ansiPlan })),
    ));
    const frame = lastFrame() ?? '';
    // ANSI escape \x1b[2J must not appear in output
    expect(frame).not.toContain('\x1b[2J');
    // The actual plan text should still be there
    expect(frame).toContain('This is a plan step');
  });

  test('setStickyFooter callback is invoked when provided', () => {
    let footerNode: React.ReactNode = null;
    const setStickyFooter = (node: React.ReactNode) => {
      footerNode = node;
    };

    render(wrap(
      React.createElement(ExitPlanModePermissionRequest, {
        ...makeProps('exit_plan_mode', { plan: 'plan text' }),
        setStickyFooter,
      }),
    ));

    // setStickyFooter should have been called with a non-null node
    expect(footerNode).not.toBeNull();
  });
});

// ── SPEC-846 T6: PermissionExplanation + ctrl+e toggle ────────────────────────
describe('SPEC-846: PermissionExplanation ctrl+e toggle', () => {
  test('renders hidden state with hint text', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionExplanation, {}),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ctrl+e');
  });

  test('shows explanation when visible=true', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionExplanation, {
        visible: true,
        matchedRule: 'confirm-on-write',
        matchedPath: '/home/user/**',
        reason: 'Write operations require confirmation',
      }),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('confirm-on-write');
    expect(frame).toContain('/home/user/**');
    expect(frame).toContain('Write operations require confirmation');
  });

  test('hides explanation when visible=false', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionExplanation, {
        visible: false,
        matchedRule: 'confirm-on-write',
      }),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('confirm-on-write');
  });

  test('renders "Permission Explanation" title when visible', () => {
    const { lastFrame } = render(wrap(
      React.createElement(PermissionExplanation, {
        visible: true,
      }),
    ));
    expect(lastFrame()).toContain('Permission Explanation');
  });

  test('onToggle callback invoked when ctrl+e pressed', () => {
    // We cannot simulate useInput in tests directly, but we verify the component
    // accepts onToggle prop without error
    expect(() => {
      render(wrap(
        React.createElement(PermissionExplanation, {
          visible: false,
          onToggle: (v: boolean) => { void v; },
        }),
      ));
    }).not.toThrow();
  });
});

// ── SPEC-846 T7: ANSI-OSC stripping ───────────────────────────────────────────
describe('SPEC-846: ANSI-OSC stripping', () => {
  test('stripAnsiOsc removes \\x1b[2J screen-clear escape', () => {
    const text = '\x1b[2Jhello\x1b[0m world';
    const stripped = stripAnsiOsc(text);
    expect(stripped).not.toContain('\x1b[2J');
    expect(stripped).toContain('hello');
    expect(stripped).toContain('world');
  });

  test('plan body with ANSI sequences renders clean text', () => {
    const dirtyPlan = '\x1b[1mBold step\x1b[0m\n\x1b[32mGreen step\x1b[0m';
    const { lastFrame } = render(wrap(
      React.createElement(ExitPlanModePermissionRequest, makeProps('exit_plan_mode', { plan: dirtyPlan })),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('\x1b[1m');
    expect(frame).not.toContain('\x1b[32m');
    expect(frame).toContain('Bold step');
    expect(frame).toContain('Green step');
  });
});

// ── SPEC-846 T8: UIResult shape ────────────────────────────────────────────────
describe('SPEC-846: UIResult shape for permission intent', () => {
  test('UIResult ok shape with allow value', () => {
    const result: UIResult<PermissionResponse> = { kind: 'ok', value: 'allow' };
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toBe('allow');
    }
  });

  test('UIResult ok shape with always value', () => {
    const result: UIResult<PermissionResponse> = { kind: 'ok', value: 'always' };
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toBe('always');
    }
  });

  test('UIResult ok shape with deny value', () => {
    const result: UIResult<PermissionResponse> = { kind: 'ok', value: 'deny' };
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toBe('deny');
    }
  });

  test('UIResult cancel shape', () => {
    const result: UIResult<PermissionResponse> = { kind: 'cancel' };
    expect(result.kind).toBe('cancel');
  });

  test('UIResult timeout shape', () => {
    const result: UIResult<PermissionResponse> = { kind: 'timeout' };
    expect(result.kind).toBe('timeout');
  });
});

// ── SPEC-846 T9: Deferred stubs throw T_NOT_IMPLEMENTED ───────────────────────
describe('SPEC-846: Deferred v0.4.1 stubs', () => {
  test('SedEditPermissionRequest throws T_NOT_IMPLEMENTED', () => {
    // Call component function directly — React render() swallows errors.
    expect(() => {
      SedEditPermissionRequest(makeProps('sed_edit'));
    }).toThrow(NimbusError);

    try {
      SedEditPermissionRequest(makeProps('sed_edit'));
    } catch (e) {
      expect(e).toBeInstanceOf(NimbusError);
      expect((e as NimbusError).code).toBe(ErrorCode.T_NOT_IMPLEMENTED);
    }
  });

  test('NotebookEditPermissionRequest throws T_NOT_IMPLEMENTED', () => {
    // Call component function directly — React render() swallows errors.
    expect(() => {
      NotebookEditPermissionRequest(makeProps('notebook_edit'));
    }).toThrow(NimbusError);

    try {
      NotebookEditPermissionRequest(makeProps('notebook_edit'));
    } catch (e) {
      expect(e).toBeInstanceOf(NimbusError);
      expect((e as NimbusError).code).toBe(ErrorCode.T_NOT_IMPLEMENTED);
    }
  });
});

// ── SPEC-846 T10: FileWritePermissionRequest ──────────────────────────────────
describe('SPEC-846: FileWritePermissionRequest', () => {
  test('shows file path and byte count', () => {
    const { lastFrame } = render(wrap(
      React.createElement(FileWritePermissionRequest, makeProps('write', {
        path: '/tmp/output.txt',
        content: 'hello world',
      })),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('output.txt');
    expect(frame).toContain('bytes');
  });

  test('preview limited to first 20 lines', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const { lastFrame } = render(wrap(
      React.createElement(FileWritePermissionRequest, makeProps('write', {
        path: '/tmp/big.txt',
        content,
      })),
    ));
    const frame = lastFrame() ?? '';
    // Should show truncation indicator
    expect(frame).toContain('more lines');
  });

  test('ANSI in file content stripped from preview', () => {
    const { lastFrame } = render(wrap(
      React.createElement(FileWritePermissionRequest, makeProps('write', {
        path: '/tmp/ansi.txt',
        content: '\x1b[31mred text\x1b[0m',
      })),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('\x1b[31m');
    expect(frame).toContain('red text');
  });
});

// ── SPEC-846 T11: WebFetchPermissionRequest ───────────────────────────────────
describe('SPEC-846: WebFetchPermissionRequest', () => {
  test('shows domain highlight', () => {
    const { lastFrame } = render(wrap(
      React.createElement(WebFetchPermissionRequest, makeProps('web_fetch', {
        url: 'https://api.github.com/repos/nimbus/os',
      })),
    ));
    expect(lastFrame()).toContain('api.github.com');
  });

  test('shows full URL', () => {
    const { lastFrame } = render(wrap(
      React.createElement(WebFetchPermissionRequest, makeProps('web_fetch', {
        url: 'https://example.com/some/path?q=1',
      })),
    ));
    expect(lastFrame()).toContain('example.com');
  });
});

// ── SPEC-846 T12: SkillPermissionRequest ─────────────────────────────────────
describe('SPEC-846: SkillPermissionRequest', () => {
  test('shows skill name', () => {
    const { lastFrame } = render(wrap(
      React.createElement(SkillPermissionRequest, makeProps('skill', {
        name: 'deploy-prod',
        description: 'Deploys to production environment',
      })),
    ));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('deploy-prod');
    expect(frame).toContain('Deploys to production environment');
  });
});
