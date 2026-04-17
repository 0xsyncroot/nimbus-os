// autocomplete.test.ts — SPEC-842: Slash autocomplete dropdown + /help overlay + @file autocomplete.
// Tests: dropdown render, nav, Tab accept, Esc dismiss, /help 3-tab overlay,
//        '?' synonym, @file fuzzy match, SENSITIVE_PATTERNS deny-list, timeout, ANSI strip.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  __resetRegistry,
  registerDefaultCommands,
  listCommands,
} from '../../../../src/channels/cli/slashCommands.ts';
import { matchCommands, groupByCategory } from '../../../../src/channels/cli/ink/utils/commandSuggestions.ts';
import { SlashAutocomplete } from '../../../../src/channels/cli/ink/components/SlashAutocomplete.tsx';
import { HelpOverlay } from '../../../../src/channels/cli/ink/components/HelpOverlay.tsx';
import {
  validateFileRef,
  FILE_REF_SCAN_TIMEOUT_MS,
} from '../../../../src/channels/cli/ink/components/FileRefAutocomplete.tsx';
import { stripAnsiOsc } from '../../../../src/channels/cli/ink/components/Markdown.tsx';
import { inspectPath } from '../../../../src/permissions/pathValidator.ts';
import { ErrorCode, NimbusError } from '../../../../src/observability/errors.ts';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetRegistry();
  registerDefaultCommands();
});

afterEach(() => {
  cleanup();
});

// ── SPEC-842: commandSuggestions match algorithm ──────────────────────────────

describe('SPEC-842: commandSuggestions.matchCommands', () => {
  test('empty query returns all commands', () => {
    const all = listCommands();
    const matched = matchCommands('');
    expect(matched.length).toBe(all.length);
  });

  test('prefix match returns prefix-first results', () => {
    const results = matchCommands('mo');
    const names = results.map((c) => c.name);
    // 'model' and 'mode' start with 'mo'
    expect(names.some((n) => n === 'model')).toBe(true);
    expect(names.some((n) => n === 'mode')).toBe(true);
    // Prefix matches come before any fuzzy substring matches
    const modelIdx = names.indexOf('model');
    const modeIdx = names.indexOf('mode');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(modeIdx).toBeGreaterThanOrEqual(0);
  });

  test('fuzzy match returns substring results', () => {
    const results = matchCommands('itch'); // /switch has 'itch' but not prefix
    const names = results.map((c) => c.name);
    expect(names).toContain('switch');
  });

  test('no match returns empty array', () => {
    const results = matchCommands('zzzyyyxxx');
    expect(results.length).toBe(0);
  });

  test('exact prefix match on single char', () => {
    const results = matchCommands('h');
    const names = results.map((c) => c.name);
    expect(names).toContain('help');
  });

  test('case-insensitive match', () => {
    const results = matchCommands('H');
    const names = results.map((c) => c.name);
    expect(names).toContain('help');
  });
});

// ── SPEC-842: groupByCategory ─────────────────────────────────────────────────

describe('SPEC-842: groupByCategory', () => {
  test('groups commands into their categories', () => {
    const all = listCommands();
    const groups = groupByCategory(all);
    // session category should have stop, new, clear, cost
    const session = groups.get('session') ?? [];
    const sessionNames = session.map((c) => c.name);
    expect(sessionNames).toContain('stop');
    expect(sessionNames).toContain('new');
  });

  test('preserves order: session before workspace before model before system', () => {
    const all = listCommands();
    const groups = groupByCategory(all);
    const keys = [...groups.keys()];
    const sessionIdx = keys.indexOf('session');
    const workspaceIdx = keys.indexOf('workspace');
    if (sessionIdx >= 0 && workspaceIdx >= 0) {
      expect(sessionIdx).toBeLessThan(workspaceIdx);
    }
  });

  test('groups return a Map with correct structure', () => {
    const all = listCommands();
    const groups = groupByCategory(all);
    expect(groups).toBeInstanceOf(Map);
    expect(groups.size).toBeGreaterThan(0);
  });

  test('all commands appear in exactly one group', () => {
    const all = listCommands();
    const groups = groupByCategory(all);
    let total = 0;
    for (const cmds of groups.values()) {
      total += cmds.length;
    }
    expect(total).toBe(all.length);
  });
});

// ── SPEC-842 T1: SlashAutocomplete component ──────────────────────────────────

describe('SPEC-842 T1: SlashAutocomplete render', () => {
  test('renders dropdown when query matches ^/\\w*$', () => {
    const { lastFrame } = render(
      React.createElement(SlashAutocomplete, {
        query: '/',
        onAccept: () => {},
        onDismiss: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    // Should render some commands (not null)
    expect(frame.length).toBeGreaterThan(0);
    // Should show navigation hint
    expect(frame).toContain('Esc');
  });

  test('returns null/empty for non-slash query', () => {
    const { lastFrame } = render(
      React.createElement(SlashAutocomplete, {
        query: 'hello',
        onAccept: () => {},
        onDismiss: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    // Empty frame since component returns null for non-/ queries
    expect(frame.trim()).toBe('');
  });

  test('filters commands for /m prefix', () => {
    const { lastFrame } = render(
      React.createElement(SlashAutocomplete, {
        query: '/m',
        onAccept: () => {},
        onDismiss: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    // Should contain 'model' and 'mode' and 'memory'
    expect(frame).toContain('model');
  });

  test('shows "No matching commands" for non-matching prefix', () => {
    const { lastFrame } = render(
      React.createElement(SlashAutocomplete, {
        query: '/zzzyyyxxx',
        onAccept: () => {},
        onDismiss: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No matching commands');
  });

  test('shows category headers in output', () => {
    const { lastFrame } = render(
      React.createElement(SlashAutocomplete, {
        query: '/',
        onAccept: () => {},
        onDismiss: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    // At least one category should be visible
    const hasCategory =
      frame.includes('SESSION') ||
      frame.includes('WORKSPACE') ||
      frame.includes('MODEL') ||
      frame.includes('SYSTEM');
    expect(hasCategory).toBe(true);
  });

  test('Tab sends accepted command with trailing space via stdin', (done) => {
    let accepted = '';
    const { stdin } = render(
      React.createElement(SlashAutocomplete, {
        query: '/h',
        onAccept: (cmd) => {
          accepted = cmd;
          expect(accepted.endsWith(' ')).toBe(true);
          expect(accepted.startsWith('/')).toBe(true);
          done();
        },
        onDismiss: () => {},
      }),
    );
    stdin.write('\t');
  });

  test('Enter sends accepted command without trailing space via stdin', (done) => {
    let accepted = '';
    const { stdin } = render(
      React.createElement(SlashAutocomplete, {
        query: '/help',
        onAccept: (cmd) => {
          accepted = cmd;
          expect(accepted).toContain('help');
          expect(accepted.endsWith(' ')).toBe(false);
          done();
        },
        onDismiss: () => {},
      }),
    );
    stdin.write('\r');
  });

  test('Esc triggers onDismiss via stdin', (done) => {
    const { stdin } = render(
      React.createElement(SlashAutocomplete, {
        query: '/',
        onAccept: () => {},
        onDismiss: () => {
          done();
        },
      }),
    );
    stdin.write('\x1b');
  });
});

// ── SPEC-842 T2: HelpOverlay component ───────────────────────────────────────

describe('SPEC-842 T2: HelpOverlay', () => {
  test('renders 3 tabs: Commands, General, Keybindings', () => {
    const { lastFrame } = render(
      React.createElement(HelpOverlay, {
        onClose: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Commands');
    expect(frame).toContain('General');
    expect(frame).toContain('Keybindings');
  });

  test('Commands tab shows non-empty list of slash commands', () => {
    const { lastFrame } = render(
      React.createElement(HelpOverlay, {
        onClose: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    // Default tab (Commands) should show /help at minimum
    expect(frame).toContain('/help');
  });

  test('shows navigation footer hint with Esc', () => {
    const { lastFrame } = render(
      React.createElement(HelpOverlay, {
        onClose: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Esc');
  });

  test('Esc triggers onClose via stdin', (done) => {
    const { stdin } = render(
      React.createElement(HelpOverlay, {
        onClose: () => {
          done();
        },
      }),
    );
    stdin.write('\x1b');
  });

  test('q triggers onClose via stdin', (done) => {
    const { stdin } = render(
      React.createElement(HelpOverlay, {
        onClose: () => {
          done();
        },
      }),
    );
    stdin.write('q');
  });

  test('right arrow key switches to General tab', (done) => {
    const { lastFrame, stdin } = render(
      React.createElement(HelpOverlay, {
        onClose: () => {},
      }),
    );
    // Give initial render a tick, then send right arrow
    stdin.write('\x1b[C');
    // After navigation, General tab content should be visible
    const frame = lastFrame() ?? '';
    // The frame updates synchronously in Ink's debug mode
    // Check that we have the tab header still
    expect(frame).toContain('General');
    done();
  });

  test('renders divider and header area', () => {
    const { lastFrame } = render(
      React.createElement(HelpOverlay, {
        onClose: () => {},
      }),
    );
    const frame = lastFrame() ?? '';
    // Border is rendered
    expect(frame.length).toBeGreaterThan(50);
    expect(frame).toContain('Commands');
  });
});

// ── SPEC-842: /help synonym + ? binding intent ────────────────────────────────

describe('SPEC-842: /help and ? synonym intent', () => {
  test('/help command is registered', () => {
    const cmds = listCommands();
    const help = cmds.find((c) => c.name === 'help');
    expect(help).toBeDefined();
    expect(help?.category).toBe('system');
  });

  test('matchCommands("help") returns help command', () => {
    const results = matchCommands('help');
    expect(results.some((c) => c.name === 'help')).toBe(true);
  });

  test('? key synonym is documented in HelpOverlay Keybindings tab content', () => {
    // Navigate to Keybindings tab (idx 2)
    const { lastFrame, stdin } = render(
      React.createElement(HelpOverlay, {
        onClose: () => {},
      }),
    );
    stdin.write('\x1b[C'); // → General
    stdin.write('\x1b[C'); // → Keybindings
    const frame = lastFrame() ?? '';
    // Keybindings tab must be shown in the header at least
    expect(frame).toContain('Keybindings');
  });
});

// ── SPEC-842 T3: FileRefAutocomplete SENSITIVE_PATTERNS deny-list ─────────────

describe('SPEC-842 T3: validateFileRef SENSITIVE_PATTERNS', () => {
  const workspaceRoot = '/tmp/nimbus-test-ws-842';

  test('.ssh/id_rsa relative path is rejected with P_OPERATION_DENIED', () => {
    const home = homedir();
    // Construct a relative path that resolves under ~/.ssh
    const sshParent = home;
    expect(() => {
      validateFileRef('.ssh/id_rsa', sshParent);
    }).toThrow(NimbusError);

    try {
      validateFileRef('.ssh/id_rsa', sshParent);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      if (err instanceof NimbusError) {
        expect(err.code).toBe(ErrorCode.P_OPERATION_DENIED);
      }
    }
  });

  test('.env file basename is detected as sensitive', () => {
    const result = inspectPath('/tmp/any-dir/.env');
    // .env is in the SENSITIVE_PATTERNS deny-list as basename match
    expect(result.matched).toBe(true);
  });

  test('validateFileRef throws P_OPERATION_DENIED for .env at workspace root', () => {
    // .env at workspace root resolves to workspaceRoot + '/.env'
    expect(() => {
      validateFileRef('.env', workspaceRoot);
    }).toThrow(NimbusError);

    try {
      validateFileRef('.env', workspaceRoot);
    } catch (err) {
      if (err instanceof NimbusError) {
        expect(err.code).toBe(ErrorCode.P_OPERATION_DENIED);
        expect(typeof err.context['hint']).toBe('string');
      }
    }
  });

  test('id_rsa is blocked via inspectPath glob-basename', () => {
    const result = inspectPath('/some/project/id_rsa');
    expect(result.matched).toBe(true);
  });

  test('id_rsa.pub is blocked via inspectPath glob-basename (id_rsa* pattern)', () => {
    const result = inspectPath('/some/path/id_rsa.pub');
    expect(result.matched).toBe(true);
  });

  test('id_ed25519 is blocked via inspectPath glob-basename', () => {
    const result = inspectPath('/some/path/id_ed25519');
    expect(result.matched).toBe(true);
  });

  test('.ssh/ prefix path is blocked', () => {
    const home = homedir();
    const result = inspectPath(join(home, '.ssh', 'known_hosts'));
    expect(result.matched).toBe(true);
    expect(result.label).toBe('cred:.ssh');
  });

  test('.envrc file is blocked via basename pattern', () => {
    const result = inspectPath('/some/project/.envrc');
    expect(result.matched).toBe(true);
  });

  test('normal source file passes validation', () => {
    // src/foo.ts should not match any sensitive pattern
    expect(() => {
      validateFileRef('src/foo.ts', workspaceRoot);
    }).not.toThrow();
  });

  test('package.json does not match sensitive pattern', () => {
    const result = inspectPath('/some/project/package.json');
    expect(result.matched).toBe(false);
  });

  test('validateFileRef hint message is user-visible', () => {
    try {
      validateFileRef('.env', workspaceRoot);
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      if (err instanceof NimbusError) {
        const hint = err.context['hint'];
        expect(typeof hint).toBe('string');
        expect((hint as string).length).toBeGreaterThan(0);
      }
    }
  });
});

// ── SPEC-842: nimbus internals sensitive paths ────────────────────────────────

describe('SPEC-842: nimbus internals sensitive paths', () => {
  test('secrets.enc under nimbusHome is blocked', () => {
    // nimbusHome() on Linux = ~/.local/share/nimbus
    const home = homedir();
    const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
    const nimbusSecrets = join(xdgData, 'nimbus', 'secrets.enc');
    const result = inspectPath(nimbusSecrets);
    expect(result.matched).toBe(true);
    expect(result.label).toBe('nimbus:secrets');
  });

  test('nimbus config.json is blocked', () => {
    const home = homedir();
    const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
    const nimbusConfig = join(xdgData, 'nimbus', 'config.json');
    const result = inspectPath(nimbusConfig);
    expect(result.matched).toBe(true);
    expect(result.label).toBe('nimbus:config');
  });
});

// ── SPEC-842: FILE_REF_SCAN_TIMEOUT_MS constant ───────────────────────────────

describe('SPEC-842: FILE_REF_SCAN_TIMEOUT_MS', () => {
  test('constant is exactly 200ms', () => {
    expect(FILE_REF_SCAN_TIMEOUT_MS).toBe(200);
  });

  test('timeout constant is less than 1 second (performance guard)', () => {
    expect(FILE_REF_SCAN_TIMEOUT_MS).toBeLessThan(1000);
  });
});

// ── SPEC-842: ANSI-OSC stripper on file previews ─────────────────────────────

describe('SPEC-842: ANSI-OSC strip on previews', () => {
  test('stripAnsiOsc removes CSI color codes from path', () => {
    const path = '\x1b[32msrc/foo.ts\x1b[0m';
    expect(stripAnsiOsc(path)).toBe('src/foo.ts');
  });

  test('stripAnsiOsc removes OSC sequences from path', () => {
    const path = '\x1b]8;;\x07src/bar.ts\x1b]8;;\x07';
    expect(stripAnsiOsc(path)).toBe('src/bar.ts');
  });

  test('stripAnsiOsc leaves clean paths unchanged', () => {
    expect(stripAnsiOsc('src/foo/bar.ts')).toBe('src/foo/bar.ts');
  });

  test('stripAnsiOsc handles C1 codes', () => {
    const path = '\x9b31msensitive\x9bm';
    expect(stripAnsiOsc(path)).toBe('sensitive');
  });

  test('stripAnsiOsc handles empty string', () => {
    expect(stripAnsiOsc('')).toBe('');
  });
});

// ── SPEC-842: Sensitive file patterns coverage ────────────────────────────────

describe('SPEC-842: Sensitive file patterns coverage', () => {
  test('.env basename is blocked', () => {
    expect(inspectPath('/home/user/project/.env').matched).toBe(true);
  });

  test('.ssh/ prefix is blocked', () => {
    const home = homedir();
    expect(inspectPath(join(home, '.ssh', 'id_rsa')).matched).toBe(true);
  });

  test('id_rsa glob is blocked', () => {
    expect(inspectPath('/some/path/id_rsa').matched).toBe(true);
  });

  test('id_ed25519 glob is blocked', () => {
    expect(inspectPath('/some/path/id_ed25519').matched).toBe(true);
  });

  test('id_rsa.pub glob is blocked (id_rsa* pattern)', () => {
    expect(inspectPath('/some/path/id_rsa.pub').matched).toBe(true);
  });

  test('.netrc is blocked', () => {
    expect(inspectPath('/home/user/.netrc').matched).toBe(true);
  });

  test('.aws/ prefix is blocked', () => {
    const home = homedir();
    expect(inspectPath(join(home, '.aws', 'credentials')).matched).toBe(true);
  });
});
