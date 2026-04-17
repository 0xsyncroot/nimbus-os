// welcome.ts — SPEC-824 T2/T3/T4: CLI welcome screen with mascot + earth-brown palette.
// @deprecated SPEC-853: Replaced by src/channels/cli/ink/components/Welcome.tsx (Ink-native).
//   Kept alive for NIMBUS_UI=legacy code path. SPEC-851 (repl integration) will cut over;
//   schedule deletion in v0.4.1. Do NOT add new callers here.
// Four variants: full-wide (cols≥70), full-stacked (40≤cols<70), compact (returning <1h, cols≥60), plain.
// NO emoji, NO figlet, NO animation. Static ANSI only.

import {
  EARTH_DIM,
  EARTH_GOLD,
  EARTH_LIGHT,
  LAYOUT_WIDE_MIN,
  RESET,
  DIM,
  isColorEnabled,
  stripAnsi,
} from './colors.ts';
import { MASCOT_HEIGHT, MASCOT_WIDTH, renderMascot } from './mascot.ts';

// RESET and DIM are plain string constants; alias to functions for isColorEnabled() gate.
function r(): string { return isColorEnabled() ? RESET : ''; }
function d(): string { return isColorEnabled() ? DIM : ''; }

// ---------------------------------------------------------------------------
// Public types — WelcomeInput signature UNCHANGED (API compat SPEC-824 §3)
// ---------------------------------------------------------------------------

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

// v0.3.3 fix: STALE_SECONDS shortened to 5 min so the prominent full banner
// appears on most reopens. User report: "welcome screen missing" was actually
// the 1-line compact variant being missed against terminal noise — keeping
// compact rare while still saving on rapid reconnects.
const STALE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Layout constants (SPEC-824 §layout math)
// ---------------------------------------------------------------------------

const WIDE_PADDING_L = 3;
const WIDE_GUTTER = 3;
const WIDE_PADDING_R = 2;
// Right-text width = cols - (WIDE_PADDING_L + MASCOT_WIDTH + WIDE_GUTTER + WIDE_PADDING_R)
// = cols - (3 + 13 + 3 + 2) = cols - 21

// ---------------------------------------------------------------------------
// Variant selector (SPEC-824 T4: narrow cutoff cols<40 → plain, was <60)
// ---------------------------------------------------------------------------

export function pickVariant(input: WelcomeInput): WelcomeVariant {
  const env = process.env['NIMBUS_FORCE_WELCOME'];
  if (env === 'full' || env === 'compact' || env === 'plain') return env;
  if (input.force) return input.force;

  // Degrade to plain for non-color / non-TTY / very narrow terminals
  if (input.noColor || !input.isTTY || input.cols < 40) return 'plain';

  // v0.3.3 fix — user report: "welcome screen missing on boot". Root cause:
  // the 1-line compact variant (picked <1h since last boot) was visually
  // indistinguishable from the prompt row, so users perceived no banner at
  // all. Pick compact only for genuinely rapid reopens (<5 min), otherwise
  // the full mascot banner. STALE_SECONDS already narrowed accordingly.
  const firstRun = !input.numStartups || input.numStartups <= 1;
  if (firstRun) return 'full';

  const now = Math.floor(Date.now() / 1000);
  const lastBoot = input.lastBootAt ?? 0;
  if (now - lastBoot > STALE_SECONDS) return 'full';

  return 'compact';
}

// ---------------------------------------------------------------------------
// Helper: truncate a line to fit visible cols
// ---------------------------------------------------------------------------

function fitLine(line: string, cols: number): string {
  const visible = stripAnsi(line);
  if (visible.length <= cols) return line;
  return visible.slice(0, cols);
}

// ---------------------------------------------------------------------------
// Build the 5 right-column text lines for full variant
// ---------------------------------------------------------------------------

function buildTextLines(input: WelcomeInput, maxWidth: number): string[] {
  const R = r();
  const gold = EARTH_GOLD();
  const light = EARTH_LIGHT();
  const dim = EARTH_DIM();
  const ddim = d();

  const notes = input.memoryNoteCount ?? 0;
  const providerLabel = input.providerKind === 'anthropic'
    ? 'anthropic'
    : (input.endpoint ?? 'openai-compat');

  // Line 1: "nimbus  v{version}" — use "nimbus" + DIM for now (no version field in WelcomeInput)
  const line1 = fitLine(`${gold}nimbus${R}  ${ddim}personal AI OS${R}`, maxWidth);
  // Line 2: "Welcome back, {wsName}."
  const line2 = fitLine(`${light}Welcome back, ${R}${light}${input.wsName}${R}${light}.${R}`, maxWidth);
  // Line 3: blank
  const line3 = '';
  // Line 4: workspace info
  const line4 = fitLine(
    `${ddim}workspace  ·  ${R}${dim}${input.wsName}  ·  ${notes} notes${R}`,
    maxWidth,
  );
  // Line 5: model info
  const line5 = fitLine(
    `${ddim}model      ·  ${R}${dim}${input.model} (${providerLabel})${R}`,
    maxWidth,
  );

  return [line1, line2, line3, line4, line5];
}

// ---------------------------------------------------------------------------
// Full variant — wide layout (cols ≥ LAYOUT_WIDE_MIN)
// Mascot (13 cols) zipped with 5 text lines, footer below.
// ---------------------------------------------------------------------------

function renderWide(input: WelcomeInput): string {
  const R = r();
  const ddim = d();
  const cols = input.cols;
  const rightWidth = cols - (WIDE_PADDING_L + MASCOT_WIDTH + WIDE_GUTTER + WIDE_PADDING_R);

  const mascotLines = renderMascot();
  const textLines = buildTextLines(input, rightWidth);

  const paddingL = ' '.repeat(WIDE_PADDING_L);
  const gutter = ' '.repeat(WIDE_GUTTER);

  const zipped: string[] = [];
  for (let i = 0; i < MASCOT_HEIGHT; i++) {
    const mLine = mascotLines[i] ?? ' '.repeat(MASCOT_WIDTH);
    const tLine = textLines[i] ?? '';
    zipped.push(`${paddingL}${mLine}${gutter}${tLine}${R}`);
  }

  const footer = fitLine(
    `  ${ddim}/help${R}  ${ddim}for commands   ·   Ctrl-C twice to exit${R}`,
    cols,
  );

  return ['', ...zipped, footer, ''].join('\n');
}

// ---------------------------------------------------------------------------
// Full variant — stacked layout (40 ≤ cols < LAYOUT_WIDE_MIN)
// Mascot block (indent 1), blank, text lines (indent 1), blank, footer.
// ---------------------------------------------------------------------------

function renderStacked(input: WelcomeInput): string {
  const R = r();
  const ddim = d();
  const cols = input.cols;
  const indent = ' ';

  const mascotLines = renderMascot().map((l) => `${indent}${l}`);
  const textLines = buildTextLines(input, cols - 1).map((l) => (l ? `${indent}${l}` : ''));
  const footer = fitLine(
    `${indent}${ddim}/help  for commands   ·   Ctrl-C twice to exit${R}`,
    cols,
  );

  return ['', ...mascotLines, '', ...textLines, '', footer, ''].join('\n');
}

// ---------------------------------------------------------------------------
// Full variant dispatcher
// ---------------------------------------------------------------------------

function renderFull(input: WelcomeInput): string {
  if (input.cols >= LAYOUT_WIDE_MIN) return renderWide(input);
  return renderStacked(input);
}

// ---------------------------------------------------------------------------
// Compact variant (SPEC-824 T3): single line, no mascot (cols ≥ 60 implied by pickVariant)
// ░▒▓ nimbus ready  ·  {wsName}  ·  {model}  ·  {notes} notes    /help · Ctrl-C×2
// ---------------------------------------------------------------------------

function renderCompact(input: WelcomeInput): string {
  const R = r();
  const light = EARTH_LIGHT();
  const dim = EARTH_DIM();
  const ddim = d();

  const notes = input.memoryNoteCount ?? 0;

  // Shaded prefix (CP437-safe)
  const prefix = isColorEnabled()
    ? `${dim}░▒▓${R} `
    : '░▒▓ ';

  const line = fitLine(
    `${prefix}${light}nimbus ready${R}  ${ddim}·${R}  ${dim}${input.wsName}${R}  ${ddim}·${R}  ${dim}${input.model}${R}  ${ddim}·${R}  ${dim}${notes} notes${R}    ${ddim}/help · Ctrl-C×2${R}`,
    input.cols,
  );

  return line;
}

// ---------------------------------------------------------------------------
// Plain variant (SPEC-824 §plain, unchanged from v0.3.1)
// ---------------------------------------------------------------------------

function renderPlain(input: WelcomeInput): string {
  return `[OK] nimbus ready — workspace "${input.wsName}" (${input.model})`;
}

// ---------------------------------------------------------------------------
// Public entry point — renderWelcome signature UNCHANGED
// ---------------------------------------------------------------------------

export function renderWelcome(input: WelcomeInput): string {
  const variant = pickVariant(input);
  switch (variant) {
    case 'full':    return renderFull(input);
    case 'compact': return renderCompact(input);
    case 'plain':   return renderPlain(input);
  }
}
