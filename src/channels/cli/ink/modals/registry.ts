// registry.ts — SPEC-847: modal registry mapping slash commands to modal names.
// Dispatch via event bus `modal.open` topic (SPEC-851 wires subscription).
// Only maps command → modal name; actual component binding is in SPEC-851.

// ── Modal names ────────────────────────────────────────────────────────────────

export type ModalName =
  | 'help'
  | 'model'
  | 'cost'
  | 'memory'
  | 'doctor'
  | 'status'
  | 'export'
  | 'compact';

// ── Slash command → modal name mapping ────────────────────────────────────────

const COMMAND_TO_MODAL: Readonly<Record<string, ModalName>> = {
  '/help': 'help',
  '/model': 'model',
  '/cost': 'cost',
  '/memory': 'memory',
  '/doctor': 'doctor',
  '/status': 'status',
  '/export': 'export',
  '/compact': 'compact',
};

/**
 * Resolve a slash command string to its modal name.
 * Returns undefined if the command does not map to a modal.
 */
export function resolveModal(command: string): ModalName | undefined {
  return COMMAND_TO_MODAL[command];
}

/**
 * Returns all registered slash commands that open modals.
 */
export function getModalCommands(): readonly string[] {
  return Object.keys(COMMAND_TO_MODAL);
}

// ── Event bus event type ───────────────────────────────────────────────────────
// SPEC-851 subscribes to this topic and renders the appropriate modal.

export interface ModalOpenEvent {
  readonly topic: 'modal.open';
  readonly modal: ModalName;
  /** Optional data payload for modals that need context (e.g. compact summary). */
  readonly payload?: unknown;
}

export interface ModalCloseEvent {
  readonly topic: 'modal.close';
  readonly modal: ModalName;
}

export type ModalEvent = ModalOpenEvent | ModalCloseEvent;
