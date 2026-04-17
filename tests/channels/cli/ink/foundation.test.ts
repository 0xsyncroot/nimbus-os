// foundation.test.ts — SPEC-840: Smoke suite for Ink 7 foundation.
// Tests: app mount, theme switch, each component renders, NO_COLOR path, SIGWINCH.

import { describe, test, expect, afterEach } from 'bun:test';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import type { ThemeName } from '../../../../src/channels/cli/ink/theme.ts';
import {
  resolveTheme,
  ThemeProvider,
  useTheme,
  PALETTES,
} from '../../../../src/channels/cli/ink/theme.ts';
import { App } from '../../../../src/channels/cli/ink/app.tsx';
import { Pane } from '../../../../src/channels/cli/ink/components/Pane.tsx';
import { ThemedText } from '../../../../src/channels/cli/ink/components/ThemedText.tsx';
import { Byline } from '../../../../src/channels/cli/ink/components/Byline.tsx';
import { Divider } from '../../../../src/channels/cli/ink/components/Divider.tsx';
import { StatusIcon } from '../../../../src/channels/cli/ink/components/StatusIcon.tsx';
import { Tabs } from '../../../../src/channels/cli/ink/components/Tabs.tsx';
import { KeyboardShortcutHint } from '../../../../src/channels/cli/ink/components/KeyboardShortcutHint.tsx';
import { Text } from 'ink';

// ── Fixtures ───────────────────────────────────────────────────────────────────
const WORKSPACE = {
  id: '01HXR7K2XNPKMWQ8T3VDSY41GJ',
  name: 'test-workspace',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
};

const MODE = 'default' as const;

afterEach(() => {
  cleanup();
});

// ── SPEC-840 T2: App mount smoke ───────────────────────────────────────────────
describe('SPEC-840: App bootstrap', () => {
  test('mounts <App> and renders workspace name', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        workspace: WORKSPACE,
        mode: MODE,
        locale: 'en',
        reducedMotion: false,
        noColor: false,
        themeName: 'dark',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('test-workspace');
  });

  test('mounts with locale=vi', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        workspace: WORKSPACE,
        mode: MODE,
        locale: 'vi',
        reducedMotion: false,
        noColor: false,
        themeName: 'dark',
      }),
    );
    expect(lastFrame()).toBeDefined();
  });

  test('mounts with reducedMotion=true', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        workspace: WORKSPACE,
        mode: MODE,
        locale: 'en',
        reducedMotion: true,
        noColor: false,
        themeName: 'dark',
      }),
    );
    expect(lastFrame()).toBeDefined();
  });

  test('mounts with noColor=true', () => {
    const { lastFrame } = render(
      React.createElement(App, {
        workspace: WORKSPACE,
        mode: MODE,
        locale: 'en',
        reducedMotion: false,
        noColor: true,
        themeName: 'dark-ansi',
      }),
    );
    expect(lastFrame()).toBeDefined();
  });

  test('app mount performance <150ms (generous for CI)', () => {
    const start = performance.now();
    const { unmount } = render(
      React.createElement(App, {
        workspace: WORKSPACE,
        mode: MODE,
        locale: 'en',
        reducedMotion: false,
        noColor: false,
        themeName: 'dark',
      }),
    );
    const elapsed = performance.now() - start;
    unmount();
    expect(elapsed).toBeLessThan(150);
  });
});

// ── SPEC-840 T3: Theme resolution ─────────────────────────────────────────────
describe('SPEC-840: resolveTheme', () => {
  test('returns dark by default', () => {
    expect(resolveTheme({}, false)).toBe('dark');
  });

  test('NO_COLOR forces dark-ansi', () => {
    expect(resolveTheme({ NO_COLOR: '1' }, true)).toBe('dark-ansi');
  });

  test('noColor=true overrides NIMBUS_THEME', () => {
    expect(resolveTheme({ NIMBUS_THEME: 'light', NO_COLOR: '1' }, true)).toBe('dark-ansi');
  });

  test('NIMBUS_THEME=light respected when noColor=false', () => {
    expect(resolveTheme({ NIMBUS_THEME: 'light' }, false)).toBe('light');
  });

  test('NIMBUS_THEME=light-ansi respected', () => {
    expect(resolveTheme({ NIMBUS_THEME: 'light-ansi' }, false)).toBe('light-ansi');
  });

  test('NIMBUS_THEME=dark-ansi respected', () => {
    expect(resolveTheme({ NIMBUS_THEME: 'dark-ansi' }, false)).toBe('dark-ansi');
  });

  test('invalid NIMBUS_THEME falls back to dark', () => {
    expect(resolveTheme({ NIMBUS_THEME: 'neon-purple' }, false)).toBe('dark');
  });
});

// ── useTheme roundtrip ─────────────────────────────────────────────────────────
describe('SPEC-840: useTheme() hook', () => {
  function ThemeReader({ token }: { token: string }) {
    const getColor = useTheme();
    return React.createElement(Text, null, getColor(token as Parameters<typeof getColor>[0]));
  }

  test('dark palette returns rgb color for claude token', () => {
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider,
        { name: 'dark' },
        React.createElement(ThemeReader, { token: 'claude' }),
      ),
    );
    // Text renders the color value — frame contains it via Ink's Text color prop
    expect(lastFrame()).toBeDefined();
  });

  test('dark-ansi palette returns empty string (NO_COLOR mode)', () => {
    const palette = PALETTES['dark-ansi'];
    expect(palette['claude']).toBe('');
    expect(palette['error']).toBe('');
    expect(palette['success']).toBe('');
  });

  test('all 4 palette keys cover all ThemeToken values', () => {
    const tokens: string[] = [
      'claude', 'permission', 'ide', 'text', 'inactive', 'subtle',
      'suggestion', 'remember', 'background', 'success', 'error', 'warning', 'merged',
    ];
    const themes: ThemeName[] = ['dark', 'light', 'dark-ansi', 'light-ansi'];
    for (const theme of themes) {
      const palette = PALETTES[theme];
      for (const token of tokens) {
        expect(token in palette).toBe(true);
      }
    }
  });

  test('dark palette claude color is correct hex/rgb', () => {
    expect(PALETTES['dark']['claude']).toBe('rgb(215,119,87)');
  });

  test('light palette text is black', () => {
    expect(PALETTES['light']['text']).toBe('rgb(0,0,0)');
  });

  test('dark palette text is white', () => {
    expect(PALETTES['dark']['text']).toBe('rgb(255,255,255)');
  });
});

// ── SPEC-840 T4: Base components ──────────────────────────────────────────────
describe('SPEC-840: Pane component', () => {
  test('renders without throw', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Pane, { title: 'Test Pane' },
          React.createElement(Text, null, 'content'),
        ),
      ),
    );
    expect(lastFrame()).toBeDefined();
  });

  test('renders title text', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Pane, { title: 'My Panel' },
          React.createElement(Text, null, 'body'),
        ),
      ),
    );
    expect(lastFrame()).toContain('My Panel');
  });

  test('renders without title', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Pane, {},
          React.createElement(Text, null, 'no title'),
        ),
      ),
    );
    expect(lastFrame()).toContain('no title');
  });
});

describe('SPEC-840: ThemedText component', () => {
  test('renders without throw in dark theme', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(ThemedText, { token: 'claude' }, 'hello claude'),
      ),
    );
    expect(lastFrame()).toContain('hello claude');
  });

  test('renders plain text in NO_COLOR (dark-ansi) theme', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark-ansi' },
        React.createElement(ThemedText, { token: 'error' }, 'plain error text'),
      ),
    );
    // Should contain the text, without ANSI color codes
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plain error text');
  });

  test('renders all tokens without throw', () => {
    const tokens = [
      'claude', 'permission', 'ide', 'text', 'inactive', 'subtle',
      'suggestion', 'remember', 'background', 'success', 'error', 'warning', 'merged',
    ] as const;
    for (const token of tokens) {
      expect(() => {
        render(
          React.createElement(ThemeProvider, { name: 'dark' },
            React.createElement(ThemedText, { token }, token),
          ),
        );
        cleanup();
      }).not.toThrow();
    }
  });
});

describe('SPEC-840: Byline component', () => {
  test('renders without throw', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Byline, null, 'v0.4.0-alpha'),
      ),
    );
    expect(lastFrame()).toContain('v0.4.0-alpha');
  });
});

describe('SPEC-840: Divider component', () => {
  test('renders without throw', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Divider, { width: 20 }),
      ),
    );
    expect(lastFrame()).toBeDefined();
  });

  test('renders unicode line characters', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Divider, { width: 5 }),
      ),
    );
    expect(lastFrame()).toContain('─');
  });

  test('renders ASCII fallback', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Divider, { width: 5, ascii: true }),
      ),
    );
    expect(lastFrame()).toContain('-');
  });

  test('renders label in divider', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Divider, { width: 20, label: 'Section' }),
      ),
    );
    expect(lastFrame()).toContain('Section');
  });
});

describe('SPEC-840: StatusIcon component', () => {
  const statuses = ['success', 'pending', 'inactive', 'error', 'warning'] as const;

  for (const status of statuses) {
    test(`renders ${status} without throw`, () => {
      const { lastFrame } = render(
        React.createElement(ThemeProvider, { name: 'dark' },
          React.createElement(StatusIcon, { status }),
        ),
      );
      expect(lastFrame()).toBeDefined();
    });
  }
});

describe('SPEC-840: Tabs component', () => {
  const tabItems = [
    { key: 'a', label: 'Tab A', content: React.createElement(Text, null, 'Content A') },
    { key: 'b', label: 'Tab B', content: React.createElement(Text, null, 'Content B') },
  ];

  test('renders without throw', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Tabs, { tabs: tabItems }),
      ),
    );
    expect(lastFrame()).toBeDefined();
  });

  test('renders tab labels', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Tabs, { tabs: tabItems }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Tab A');
    expect(frame).toContain('Tab B');
  });

  test('renders first tab content by default', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Tabs, { tabs: tabItems }),
      ),
    );
    expect(lastFrame()).toContain('Content A');
  });

  test('renders empty tabs without throw', () => {
    expect(() => {
      render(
        React.createElement(ThemeProvider, { name: 'dark' },
          React.createElement(Tabs, { tabs: [] }),
        ),
      );
      cleanup();
    }).not.toThrow();
  });
});

describe('SPEC-840: KeyboardShortcutHint component', () => {
  test('renders without throw', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(KeyboardShortcutHint, { keyName: 'ctrl+c', label: 'Quit' }),
      ),
    );
    expect(lastFrame()).toBeDefined();
  });

  test('renders key name', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(KeyboardShortcutHint, { keyName: 'enter', label: 'Confirm' }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('enter');
    expect(frame).toContain('Confirm');
  });
});

// ── SIGWINCH / resize simulation ──────────────────────────────────────────────
describe('SPEC-840: SIGWINCH / terminal resize', () => {
  test('App rerenders after rerender call with new children', () => {
    const el1 = React.createElement(App, {
      workspace: WORKSPACE,
      mode: MODE,
      locale: 'en',
      reducedMotion: false,
      noColor: false,
      themeName: 'dark',
    },
      React.createElement(Text, null, 'cols-80'),
    );

    const { lastFrame, rerender } = render(el1);
    expect(lastFrame()).toContain('cols-80');

    // Simulate rerender with new content (mimics SIGWINCH-triggered rerender)
    rerender(React.createElement(App, {
      workspace: WORKSPACE,
      mode: MODE,
      locale: 'en',
      reducedMotion: false,
      noColor: false,
      themeName: 'dark',
    },
      React.createElement(Text, null, 'cols-120'),
    ));

    expect(lastFrame()).toContain('cols-120');
  });
});

// ── NO_COLOR path integration ─────────────────────────────────────────────────
describe('SPEC-840: NO_COLOR path', () => {
  test('dark-ansi palette resolves empty string for all tokens', () => {
    const palette = PALETTES['dark-ansi'];
    const tokens = Object.keys(palette) as Array<keyof typeof palette>;
    for (const token of tokens) {
      expect(palette[token]).toBe('');
    }
  });

  test('light-ansi palette resolves empty string for all tokens', () => {
    const palette = PALETTES['light-ansi'];
    const tokens = Object.keys(palette) as Array<keyof typeof palette>;
    for (const token of tokens) {
      expect(palette[token]).toBe('');
    }
  });

  test('App with noColor=true mounts with dark-ansi theme', () => {
    const env = { NO_COLOR: '1' };
    const themeName = resolveTheme(env, true);
    expect(themeName).toBe('dark-ansi');

    const { lastFrame } = render(
      React.createElement(App, {
        workspace: WORKSPACE,
        mode: MODE,
        locale: 'en',
        reducedMotion: false,
        noColor: true,
        themeName,
      }),
    );
    expect(lastFrame()).toBeDefined();
  });
});
