// defaultBindings.ts — SPEC-849: KeybindingAction typed union + default bindings per context.
// 9 contexts: Global, Chat, Autocomplete, Select, Confirmation, Scroll, HistorySearch, Transcript, Help.
// Chord policy: ctrl+<letter> is NEVER a chord prefix — immediate action only.
// Chords require leader key (ctrl+g or \). Preserves readline conventions.
// Reserved: ctrl+c, ctrl+d — unreboundable (handled by reservedShortcuts.ts).

import type { KeybindingContext } from './index.ts';

// ── KeybindingAction union (SPEC-849 §7) ──────────────────────────────────────

export type KeybindingAction =
  // App-level
  | 'app:interrupt'
  | 'app:exit'
  | 'app:redraw'
  | 'app:toggleHelp'
  // Chat
  | 'chat:submit'
  | 'chat:cancel'
  | 'chat:cycleMode'
  | 'chat:historyPrev'
  | 'chat:historyNext'
  // Autocomplete
  | 'autocomplete:accept'
  | 'autocomplete:dismiss'
  | 'autocomplete:next'
  | 'autocomplete:prev'
  // Select
  | 'select:accept'
  | 'select:cancel'
  | 'select:next'
  | 'select:prev'
  // Confirmation
  | 'confirmation:yes'
  | 'confirmation:no'
  | 'confirmation:toggleExplanation'
  | 'confirmation:cycleMode'
  // Scroll
  | 'scroll:pageUp'
  | 'scroll:pageDown'
  | 'scroll:home'
  | 'scroll:end'
  // Modal openers
  | 'modal:openHelp'
  | 'modal:openModel'
  | 'modal:openCost'
  | 'modal:openMemory'
  | 'modal:openDoctor'
  | 'modal:openStatus'
  // History
  | 'history:search';

// ── ContextBindings type ───────────────────────────────────────────────────────

export type ContextBindings = ReadonlyMap<string, KeybindingAction>;
export type BindingsMap = ReadonlyMap<KeybindingContext, ContextBindings>;

// ── Default bindings per context ──────────────────────────────────────────────

const GLOBAL_BINDINGS: [string, KeybindingAction][] = [
  ['ctrl+l', 'app:redraw'],
  ['ctrl+g h', 'app:toggleHelp'],      // chord: leader ctrl+g then h
  ['\\h', 'modal:openHelp'],           // chord: leader \ then h
  ['\\m', 'modal:openModel'],
  ['\\$', 'modal:openCost'],
  ['\\M', 'modal:openMemory'],
  ['\\d', 'modal:openDoctor'],
  ['\\s', 'modal:openStatus'],
];

const CHAT_BINDINGS: [string, KeybindingAction][] = [
  ['return', 'chat:submit'],
  ['ctrl+g r', 'chat:cycleMode'],       // chord: ctrl+g then r
  ['up', 'chat:historyPrev'],
  ['down', 'chat:historyNext'],
  ['ctrl+r', 'history:search'],
  ['escape', 'chat:cancel'],
];

const AUTOCOMPLETE_BINDINGS: [string, KeybindingAction][] = [
  ['tab', 'autocomplete:accept'],
  ['return', 'autocomplete:accept'],
  ['escape', 'autocomplete:dismiss'],
  ['ctrl+n', 'autocomplete:next'],
  ['ctrl+p', 'autocomplete:prev'],
  ['down', 'autocomplete:next'],
  ['up', 'autocomplete:prev'],
];

const SELECT_BINDINGS: [string, KeybindingAction][] = [
  ['return', 'select:accept'],
  ['space', 'select:accept'],
  ['escape', 'select:cancel'],
  ['ctrl+n', 'select:next'],
  ['ctrl+p', 'select:prev'],
  ['down', 'select:next'],
  ['up', 'select:prev'],
  ['j', 'select:next'],
  ['k', 'select:prev'],
];

const CONFIRMATION_BINDINGS: [string, KeybindingAction][] = [
  ['y', 'confirmation:yes'],
  ['return', 'confirmation:yes'],
  ['n', 'confirmation:no'],
  ['escape', 'confirmation:no'],
  ['?', 'confirmation:toggleExplanation'],
  ['tab', 'confirmation:cycleMode'],
];

const SCROLL_BINDINGS: [string, KeybindingAction][] = [
  ['pageup', 'scroll:pageUp'],
  ['pagedown', 'scroll:pageDown'],
  ['ctrl+b', 'scroll:pageUp'],
  ['ctrl+f', 'scroll:pageDown'],
  ['home', 'scroll:home'],
  ['end', 'scroll:end'],
  ['g', 'scroll:home'],
  ['G', 'scroll:end'],
];

const HISTORY_SEARCH_BINDINGS: [string, KeybindingAction][] = [
  ['escape', 'app:interrupt'],
  ['return', 'chat:submit'],
  ['ctrl+n', 'select:next'],
  ['ctrl+p', 'select:prev'],
];

const TRANSCRIPT_BINDINGS: [string, KeybindingAction][] = [
  ['escape', 'app:interrupt'],
  ['ctrl+b', 'scroll:pageUp'],
  ['ctrl+f', 'scroll:pageDown'],
  ['g', 'scroll:home'],
  ['G', 'scroll:end'],
];

const HELP_BINDINGS: [string, KeybindingAction][] = [
  ['escape', 'app:interrupt'],
  ['q', 'app:interrupt'],
  ['?', 'app:toggleHelp'],
];

// ── Exported defaults map ──────────────────────────────────────────────────────

export const DEFAULT_BINDINGS: BindingsMap = new Map<KeybindingContext, ContextBindings>([
  ['Global', new Map(GLOBAL_BINDINGS)],
  ['Chat', new Map(CHAT_BINDINGS)],
  ['Autocomplete', new Map(AUTOCOMPLETE_BINDINGS)],
  ['Select', new Map(SELECT_BINDINGS)],
  ['Confirmation', new Map(CONFIRMATION_BINDINGS)],
  ['Scroll', new Map(SCROLL_BINDINGS)],
  ['HistorySearch', new Map(HISTORY_SEARCH_BINDINGS)],
  ['Transcript', new Map(TRANSCRIPT_BINDINGS)],
  ['Help', new Map(HELP_BINDINGS)],
]);

// ── Chord policy helpers ───────────────────────────────────────────────────────

/**
 * Returns true if the key string is a single-modifier ctrl+<letter> binding
 * (e.g., ctrl+a, ctrl+e) that must be treated as an IMMEDIATE action and
 * never used as a chord prefix. This preserves readline/emacs conventions.
 */
export function isSingleCtrlLetter(key: string): boolean {
  return /^ctrl\+[a-z]$/.test(key);
}

/**
 * Returns true if the key string represents a chord (contains a space or
 * uses a backslash leader), requiring leader key + timeout.
 */
export function isChord(key: string): boolean {
  return key.includes(' ') || key.startsWith('\\');
}
