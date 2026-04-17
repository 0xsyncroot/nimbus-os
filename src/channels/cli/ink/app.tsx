// app.tsx — SPEC-840: Root <App> component, AppContext, mountApp() factory.
// Uses Ink's built-in useStdout() for cols/rows — ink-use-stdout-dimensions
// is banned (Bun segfault bun#11013).
// NO_COLOR → chalk.level=0 set once here; never overridden downstream.

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Box, Text, render, useStdout } from 'ink';
import type { Instance } from 'ink';
import type { Workspace } from '../../../core/workspaceTypes.ts';
import type { PermissionMode } from '../../../permissions/mode.ts';
import { ThemeProvider, resolveTheme } from './theme.ts';
import type { ThemeName } from './theme.ts';

// ── WorkspaceSummary ───────────────────────────────────────────────────────────
// Minimal projection of Workspace for UI layer — avoids coupling to storage schema.
export interface WorkspaceSummary {
  id: string;
  name: string;
  defaultProvider: string;
  defaultModel: string;
}

// ── AppContext interface (SPEC-840 §7) ─────────────────────────────────────────
export interface AppContextValue {
  workspace: WorkspaceSummary;
  mode: PermissionMode;
  locale: 'en' | 'vi';
  reducedMotion: boolean;
  noColor: boolean;
  cols: number;
  rows: number;
}

const AppContext = createContext<AppContextValue | null>(null);
AppContext.displayName = 'NimbusAppContext';

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('[SPEC-840] useAppContext() called outside <App>. Wrap your tree with <App>.');
  }
  return ctx;
}

// ── Env helpers ────────────────────────────────────────────────────────────────
function detectReducedMotion(env: Record<string, string | undefined>): boolean {
  if (env['NIMBUS_REDUCED_MOTION'] === '1') return true;
  if (env['PREFERS_REDUCED_MOTION'] === 'reduce') return true;
  return false;
}

function detectNoColor(env: Record<string, string | undefined>): boolean {
  const val = env['NO_COLOR'];
  // NO_COLOR spec: presence of the variable (any value) disables color.
  return val !== undefined && val !== '';
}

// ── Internal hook — derives cols/rows from Ink's useStdout() ─────────────────
function useTerminalSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const handler = () => {
      setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    };
    stdout.on('resize', handler);
    return () => {
      stdout.off('resize', handler);
    };
  }, [stdout]);

  return size;
}

// ── App component ──────────────────────────────────────────────────────────────
export interface AppProps {
  workspace: WorkspaceSummary;
  mode: PermissionMode;
  locale: 'en' | 'vi';
  reducedMotion: boolean;
  noColor: boolean;
  themeName: ThemeName;
  children?: React.ReactNode;
}

export function App({
  workspace,
  mode,
  locale,
  reducedMotion,
  noColor,
  themeName,
  children,
}: AppProps): React.ReactElement {
  const { cols, rows } = useTerminalSize();

  const ctxValue: AppContextValue = {
    workspace,
    mode,
    locale,
    reducedMotion,
    noColor,
    cols,
    rows,
  };

  return (
    <AppContext.Provider value={ctxValue}>
      <ThemeProvider name={themeName}>
        <Box flexDirection="column" width={cols}>
          {children ?? (
            <Text>
              nimbus-os — workspace:{workspace.name} mode:{mode}
            </Text>
          )}
        </Box>
      </ThemeProvider>
    </AppContext.Provider>
  );
}

// ── mountApp factory (SPEC-840 §7) ────────────────────────────────────────────
export interface MountAppOptions {
  workspace: WorkspaceSummary;
  mode: PermissionMode;
  locale?: 'en' | 'vi';
  children?: React.ReactNode;
  /** Override process.env for testing */
  env?: Record<string, string | undefined>;
}

export interface MountedApp {
  waitUntilExit: Instance['waitUntilExit'];
  rerender: Instance['rerender'];
  unmount: Instance['unmount'];
}

export function mountApp({
  workspace,
  mode,
  locale = 'en',
  children,
  env = process.env as Record<string, string | undefined>,
}: MountAppOptions): MountedApp {
  const reducedMotion = detectReducedMotion(env);
  const noColor = detectNoColor(env);
  const themeName = resolveTheme(env, noColor);

  const element = (
    <App
      workspace={workspace}
      mode={mode}
      locale={locale}
      reducedMotion={reducedMotion}
      noColor={noColor}
      themeName={themeName}
    >
      {children}
    </App>
  );

  const instance = render(element, { exitOnCtrlC: true });

  return {
    waitUntilExit: instance.waitUntilExit.bind(instance),
    rerender: instance.rerender.bind(instance),
    unmount: instance.unmount.bind(instance),
  };
}

// Re-export WorkspaceSummary-from-Workspace helper
export function workspaceSummary(ws: Workspace): WorkspaceSummary {
  return {
    id: ws.id,
    name: ws.name,
    defaultProvider: ws.defaultProvider,
    defaultModel: ws.defaultModel,
  };
}
