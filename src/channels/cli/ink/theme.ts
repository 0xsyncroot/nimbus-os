// theme.ts — SPEC-840: ThemeToken, 4-palette map, ThemeProvider, useTheme().
// Palette values derived from Claude Code utils/theme.ts research (read-only reference).
// 4 themes: dark (default), light, dark-ansi, light-ansi.
// resolveTheme(env, noColor) → ThemeName:
//   NO_COLOR → force dark-ansi
//   NIMBUS_THEME override → use if valid
//   else → dark

import React, { createContext, useContext } from 'react';

// ── ThemeToken union (META-011 §7) ─────────────────────────────────────────────
export type ThemeToken =
  | 'claude'
  | 'permission'
  | 'ide'
  | 'text'
  | 'inactive'
  | 'subtle'
  | 'suggestion'
  | 'remember'
  | 'background'
  | 'success'
  | 'error'
  | 'warning'
  | 'merged';

export type ThemeName = 'dark' | 'light' | 'dark-ansi' | 'light-ansi';

export type ThemePalette = Readonly<Record<ThemeToken, string>>;

// ── Dark palette (default) ─────────────────────────────────────────────────────
const DARK_PALETTE: ThemePalette = {
  claude: 'rgb(215,119,87)',
  permission: 'rgb(177,185,249)',
  ide: 'rgb(71,130,200)',
  text: 'rgb(255,255,255)',
  inactive: 'rgb(153,153,153)',
  subtle: 'rgb(80,80,80)',
  suggestion: 'rgb(177,185,249)',
  remember: 'rgb(177,185,249)',
  background: 'rgb(0,204,204)',
  success: 'rgb(78,186,101)',
  error: 'rgb(255,107,128)',
  warning: 'rgb(255,193,7)',
  merged: 'rgb(175,135,255)',
} as const;

// ── Light palette ─────────────────────────────────────────────────────────────
const LIGHT_PALETTE: ThemePalette = {
  claude: 'rgb(215,119,87)',
  permission: 'rgb(87,105,247)',
  ide: 'rgb(71,130,200)',
  text: 'rgb(0,0,0)',
  inactive: 'rgb(102,102,102)',
  subtle: 'rgb(175,175,175)',
  suggestion: 'rgb(87,105,247)',
  remember: 'rgb(0,0,255)',
  background: 'rgb(0,153,153)',
  success: 'rgb(44,122,57)',
  error: 'rgb(171,43,63)',
  warning: 'rgb(150,108,30)',
  merged: 'rgb(135,0,255)',
} as const;

// ── Dark-ANSI palette (16-colour terminals) ────────────────────────────────────
const DARK_ANSI_PALETTE: ThemePalette = {
  claude: '',    // NO_COLOR path — empty string → Ink renders without colour
  permission: '',
  ide: '',
  text: '',
  inactive: '',
  subtle: '',
  suggestion: '',
  remember: '',
  background: '',
  success: '',
  error: '',
  warning: '',
  merged: '',
} as const;

// ── Light-ANSI palette ─────────────────────────────────────────────────────────
const LIGHT_ANSI_PALETTE: ThemePalette = { ...DARK_ANSI_PALETTE } as const;

export const PALETTES: Readonly<Record<ThemeName, ThemePalette>> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
  'dark-ansi': DARK_ANSI_PALETTE,
  'light-ansi': LIGHT_ANSI_PALETTE,
} as const;

const THEME_NAMES = new Set<ThemeName>(['dark', 'light', 'dark-ansi', 'light-ansi']);

/**
 * Resolve the active theme name from the process environment.
 * Logic (in priority order):
 *  1. NO_COLOR truthy → force 'dark-ansi' (accessibility)
 *  2. NIMBUS_THEME env override (if valid ThemeName)
 *  3. Default: 'dark'
 */
export function resolveTheme(env: Record<string, string | undefined>, noColor: boolean): ThemeName {
  if (noColor) return 'dark-ansi';
  const override = env['NIMBUS_THEME'];
  if (override && THEME_NAMES.has(override as ThemeName)) {
    return override as ThemeName;
  }
  return 'dark';
}

// ── React context ─────────────────────────────────────────────────────────────
interface ThemeContextValue {
  name: ThemeName;
  palette: ThemePalette;
}

const ThemeContext = createContext<ThemeContextValue>({
  name: 'dark',
  palette: DARK_PALETTE,
});

ThemeContext.displayName = 'NimbusThemeContext';

export interface ThemeProviderProps {
  name: ThemeName;
  children?: React.ReactNode;
}

export function ThemeProvider({ name, children }: ThemeProviderProps): React.ReactElement {
  const palette = PALETTES[name];
  const value: ThemeContextValue = { name, palette };
  return React.createElement(ThemeContext.Provider, { value }, children);
}

/**
 * useTheme — returns a typed getter (token) → colour string.
 * Returns empty string for ANSI/NO_COLOR palettes (Ink renders without colour).
 */
export function useTheme(): (token: ThemeToken) => string {
  const ctx = useContext(ThemeContext);
  return (token: ThemeToken) => ctx.palette[token];
}

/**
 * useThemeName — returns the active ThemeName.
 */
export function useThemeName(): ThemeName {
  return useContext(ThemeContext).name;
}
