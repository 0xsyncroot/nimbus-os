// slashRenderer.ts — SPEC-822 T2/T3/T4: polished slash command render functions.
// Pure functions: take state, return string[]. No I/O here.

import type { SlashCommand } from './slashCommands.ts';
import { ACCENT, DIM, RESET, RULE_CHAR } from './colors.ts';

// ---------------------------------------------------------------------------
// RenderState union (§7 of spec)
// ---------------------------------------------------------------------------

export type RenderState =
  | { kind: 'list'; filtered: SlashCommand[]; selected: number }
  | { kind: 'argCard'; cmd: SlashCommand }
  | { kind: 'empty'; byCategory: Map<string, SlashCommand[]> }
  | { kind: 'fallback'; filtered: SlashCommand[]; selected: number };

// ---------------------------------------------------------------------------
// Internal layout helpers
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 10;
const KEYBIND_LEGEND = `${DIM}↑↓ select   tab complete   enter run   esc cancel${RESET}`;

/** Fixed-width name column: 40% of cols, capped at 20 chars. */
function nameColWidth(cols: number): number {
  return Math.min(Math.floor(cols * 0.4), 20);
}

/** Truncate s to maxLen chars (ASCII-width; CJK degrades to ASCII for v0.3). */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '·';
}

/** Pad or truncate s to exactly width chars. */
function padOrTruncate(s: string, width: number): string {
  const t = truncate(s, width);
  return t.padEnd(width);
}

/** Build a dim horizontal rule of exactly `cols` chars. */
function rule(cols: number): string {
  return `${DIM}${RULE_CHAR.repeat(Math.max(1, cols))}${RESET}`;
}

// ---------------------------------------------------------------------------
// T2 — renderList (filter state)
// ---------------------------------------------------------------------------

/**
 * Render a filtered list of commands with accent marker on selected.
 * Returns one string per visual line (no trailing newlines).
 */
export function renderList(
  state: Extract<RenderState, { kind: 'list' | 'fallback' }>,
  cols: number,
): string[] {
  const { filtered, selected } = state;
  if (filtered.length === 0) return [];

  const nameW = nameColWidth(cols);
  const descAvail = Math.max(0, cols - nameW - 6); // 2 indent + 1 marker + 1 space + 2 sep

  const visible = filtered.slice(0, MAX_VISIBLE);
  const lines: string[] = [];

  lines.push(rule(cols));

  for (let i = 0; i < visible.length; i++) {
    const cmd = visible[i]!;
    const isSelected = i === selected;
    const marker = isSelected ? `${ACCENT}▸${RESET}` : ' ';
    const namePart = `/${padOrTruncate(cmd.name, nameW - 1)}`; // -1 for leading /
    const descPart = descAvail > 0 ? truncate(cmd.description, descAvail) : '';

    if (isSelected) {
      lines.push(` ${marker} ${ACCENT}${namePart}${RESET}  ${descPart}`);
    } else {
      lines.push(` ${marker} ${DIM}${namePart}${RESET}  ${DIM}${descPart}${RESET}`);
    }
  }

  // scroll indicator
  if (filtered.length > MAX_VISIBLE) {
    const showing = `${1}-${Math.min(MAX_VISIBLE, filtered.length)}/${filtered.length}`;
    lines.push(`  ${DIM}${showing}${RESET}`);
  }

  lines.push(KEYBIND_LEGEND);
  return lines;
}

// ---------------------------------------------------------------------------
// T3 — renderArgCard (trailing-space state: command fully typed + space)
// ---------------------------------------------------------------------------

/**
 * Render an arg hint card when the user has typed `/cmd ` (trailing space).
 * Returns visual lines.
 */
export function renderArgCard(cmd: SlashCommand, cols: number): string[] {
  const lines: string[] = [];
  lines.push(rule(cols));

  const header = `${ACCENT}▸ /${cmd.name}${RESET}  ${DIM}${cmd.description}${RESET}`;
  lines.push(` ${header}`);

  if (cmd.argHint) {
    lines.push(`   ${DIM}arg:${RESET} ${cmd.argHint}`);
  }

  if (cmd.argChoices && cmd.argChoices.length > 0) {
    const choices = cmd.argChoices.join('  ');
    const maxW = Math.max(0, cols - 3);
    lines.push(`   ${DIM}choices:${RESET} ${truncate(choices, maxW)}`);
  }

  if (cmd.argExamples && cmd.argExamples.length > 0) {
    const examples = cmd.argExamples.join('  ');
    const maxW = Math.max(0, cols - 3);
    lines.push(`   ${DIM}e.g.:${RESET}    ${truncate(examples, maxW)}`);
  }

  lines.push(KEYBIND_LEGEND);
  return lines;
}

// ---------------------------------------------------------------------------
// T4 — renderEmpty (just '/' typed — show all commands grouped by category)
// ---------------------------------------------------------------------------

/** Canonical category order for empty picker. */
const CATEGORY_ORDER: ReadonlyArray<string> = ['session', 'workspace', 'model', 'system'];
const CATEGORY_LABELS: Record<string, string> = {
  session: 'session',
  workspace: 'workspace',
  model: 'model',
  system: 'system',
};

/**
 * Group commands by category.  Commands with no category go into 'system'.
 */
export function groupByCategory(cmds: SlashCommand[]): Map<string, SlashCommand[]> {
  const map = new Map<string, SlashCommand[]>();
  for (const cmd of cmds) {
    const cat = cmd.category ?? 'system';
    const bucket = map.get(cat) ?? [];
    bucket.push(cmd);
    map.set(cat, bucket);
  }
  return map;
}

/**
 * Render the empty state: bare '/' typed, show all 4 category groups.
 */
export function renderEmpty(cmds: SlashCommand[], cols: number): string[] {
  const byCategory = groupByCategory(cmds);
  const lines: string[] = [];
  lines.push(rule(cols));

  const nameW = nameColWidth(cols);
  const descAvail = Math.max(0, cols - nameW - 5);

  let first = true;
  for (const cat of CATEGORY_ORDER) {
    const bucket = byCategory.get(cat);
    if (!bucket || bucket.length === 0) continue;

    if (!first) lines.push('');
    first = false;

    const label = CATEGORY_LABELS[cat] ?? cat;
    lines.push(`  ${DIM}── ${label}${RESET}`);

    for (const cmd of bucket) {
      const namePart = `/${padOrTruncate(cmd.name, nameW - 1)}`;
      const descPart = descAvail > 0 ? truncate(cmd.description, descAvail) : '';
      lines.push(`   ${DIM}${namePart}${RESET}  ${DIM}${descPart}${RESET}`);
    }
  }

  lines.push('');
  lines.push(KEYBIND_LEGEND);
  return lines;
}

// ---------------------------------------------------------------------------
// T6 — diffAndWrite: partial redraw via \x1b[nF + \x1b[2K
// ---------------------------------------------------------------------------

const ESC = '\x1b';

/**
 * Compare prev and next line arrays; only rewrite changed rows.
 * Uses cursor-up (\x1b[nF) + erase line (\x1b[2K) to avoid double-paint.
 * Writes nothing if arrays are identical.
 */
export function diffAndWrite(
  prev: string[],
  next: string[],
  output: NodeJS.WritableStream,
): void {
  const maxLen = Math.max(prev.length, next.length);
  if (maxLen === 0) return;

  // Find changed row indices
  const changed: number[] = [];
  for (let i = 0; i < maxLen; i++) {
    if (prev[i] !== next[i]) changed.push(i);
  }
  if (changed.length === 0) return;

  // Build output: for each changed row, move cursor up from bottom and rewrite.
  // We write rows top-to-bottom so cursor movement is predictable.
  // Strategy: move to top of block (up by prev.length rows), then step down,
  // rewriting each changed row with \x1b[2K (erase line) + new content.
  // For rows beyond next.length, erase them.

  let out = '';

  if (prev.length > 0) {
    // Move cursor up to start of rendered block
    out += `${ESC}[${prev.length}F`;
  }

  for (let i = 0; i < maxLen; i++) {
    const nextLine = next[i] ?? '';
    if (i < prev.length && i < next.length && prev[i] === next[i]) {
      // unchanged — move down one row
      out += `${ESC}[1B`;
    } else {
      // erase + rewrite
      out += `\r${ESC}[2K${nextLine}\n`;
    }
  }

  output.write(out);
}
