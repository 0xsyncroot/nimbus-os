// welcome.ts — SPEC-823 T2: CLI welcome screen with earth-brown palette.
// Three variants: full (first-run / >1h gap), compact (quick re-launch), plain (fallback).
// NO emoji, NO figlet, NO animation. Static ANSI only.

import {
  EARTH_DEEP,
  EARTH_LIGHT,
  EARTH_DIM,
  EARTH_GOLD,
  EARTH_BARK,
  RESET,
  DIM,
  isColorEnabled,
  stripAnsi,
} from './colors.ts';

// RESET and DIM are plain string constants in colors.ts; alias them to functions
// so welcome.ts can call them with isColorEnabled() gate at render time.
function r(): string { return isColorEnabled() ? RESET : ''; }
function d(): string { return isColorEnabled() ? DIM : ''; }

export interface WelcomeInput {
  wsName: string;
  model: string;
  providerKind: 'anthropic' | 'openai-compat';
  endpoint?: string;
  lastBootAt?: number;       // unix seconds
  numStartups?: number;
  memoryNoteCount?: number;
  cols: number;
  isTTY: boolean;
  noColor: boolean;
  force?: 'full' | 'compact' | 'plain';
}

export type WelcomeVariant = 'full' | 'compact' | 'plain';

const STALE_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Variant selector
// ---------------------------------------------------------------------------

export function pickVariant(input: WelcomeInput): WelcomeVariant {
  const env = process.env['NIMBUS_FORCE_WELCOME'];
  if (env === 'full' || env === 'compact' || env === 'plain') return env;
  if (input.force) return input.force;

  // Degrade to plain for non-color / non-TTY / narrow terminals
  if (input.noColor || !input.isTTY || input.cols < 60) return 'plain';

  const firstRun = !input.numStartups || input.numStartups <= 1;
  if (firstRun) return 'full';

  const now = Math.floor(Date.now() / 1000);
  const lastBoot = input.lastBootAt ?? 0;
  if (now - lastBoot > STALE_SECONDS) return 'full';

  return 'compact';
}

// ---------------------------------------------------------------------------
// Helper: truncate a string so its visible length (after ANSI strip) fits cols
// ---------------------------------------------------------------------------

function fitLine(line: string, cols: number): string {
  const visible = stripAnsi(line);
  if (visible.length <= cols) return line;
  // Trim from the plain content — rebuild with color if needed
  const excess = visible.length - cols;
  // Simple fallback: strip ANSI, truncate, return plain
  return visible.slice(0, visible.length - excess);
}

// ---------------------------------------------------------------------------
// Full variant (~13 rows, first-run or >1h gap)
// ---------------------------------------------------------------------------

function renderFull(input: WelcomeInput): string {
  const R = r();
  const gold = EARTH_GOLD();
  const deep = EARTH_DEEP();
  const light = EARTH_LIGHT();
  const dim = EARTH_DIM();
  const bark = EARTH_BARK();
  const ddim = d();

  const cols = input.cols;
  const notes = input.memoryNoteCount ?? 0;
  const providerLabel = input.providerKind === 'anthropic' ? 'anthropic' : (input.endpoint ?? 'openai-compat');
  const startups = input.numStartups ?? 1;

  const gradient = `${bark}░${R}${dim}▒${R}${deep}▓${R}`;

  const lines: string[] = [
    '',
    fitLine(`  ${gradient} ${gold}nimbus${R}  ${light}personal AI OS${R}`, cols),
    fitLine(`  ${deep}────────────────────────${R}`, cols),
    fitLine(`  ${ddim}workspace${R}  ${light}${input.wsName}${R}`, cols),
    fitLine(`  ${ddim}model     ${R}  ${deep}${input.model}${R}`, cols),
    fitLine(`  ${ddim}provider  ${R}  ${dim}${providerLabel}${R}`, cols),
    fitLine(`  ${ddim}memory    ${R}  ${dim}${notes} note${notes !== 1 ? 's' : ''}${R}`, cols),
    fitLine(`  ${ddim}boot #    ${R}  ${dim}${startups}${R}`, cols),
    fitLine(`  ${deep}────────────────────────${R}`, cols),
    fitLine(`  ${ddim}/help${R}  ${dim}commands${R}   ${ddim}/model${R}  ${dim}switch model${R}`, cols),
    fitLine(`  ${ddim}/ws${R}    ${dim}workspaces${R}  ${ddim}/cost${R}   ${dim}usage${R}`, cols),
    fitLine(`  ${ddim}Ctrl-C twice to exit${R}`, cols),
    '',
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Compact variant (2 rows, quick re-launch)
// ---------------------------------------------------------------------------

function renderCompact(input: WelcomeInput): string {
  const R = r();
  const bark = EARTH_BARK();
  const dim = EARTH_DIM();
  const deep = EARTH_DEEP();
  const gold = EARTH_GOLD();
  const ddim = d();

  const notes = input.memoryNoteCount ?? 0;
  const gradient = `${bark}░${R}${dim}▒${R}${deep}▓${R}`;

  const line1 = fitLine(
    `${gradient} ${gold}nimbus ready${R} ${ddim}·${R} ${deep}${input.wsName}${R} ${ddim}·${R} ${dim}${input.model}${R} ${ddim}·${R} ${dim}${notes} note${notes !== 1 ? 's' : ''}${R}`,
    input.cols,
  );
  const line2 = fitLine(
    `${ddim}  /help for commands  Ctrl-C twice to exit${R}`,
    input.cols,
  );

  return `${line1}\n${line2}`;
}

// ---------------------------------------------------------------------------
// Plain variant (script-safe, always starts with [OK])
// ---------------------------------------------------------------------------

function renderPlain(input: WelcomeInput): string {
  return `[OK] nimbus ready — workspace "${input.wsName}" (${input.model})`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function renderWelcome(input: WelcomeInput): string {
  const variant = pickVariant(input);
  switch (variant) {
    case 'full':    return renderFull(input);
    case 'compact': return renderCompact(input);
    case 'plain':   return renderPlain(input);
  }
}
