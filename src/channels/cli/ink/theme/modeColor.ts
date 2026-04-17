// modeColor.ts — SPEC-848: PermissionMode → ThemeToken mapping.
// Used by StatusLine and PromptInputFooter to colorize the mode badge.

import type { PermissionMode } from '../../../../permissions/mode.ts';
import type { ThemeToken } from '../theme.ts';

/**
 * getModeColor — map a PermissionMode to a ThemeToken for badge coloring.
 *
 * Mapping (SPEC-848 §7):
 *   readonly      → 'inactive'   (dim, no-risk)
 *   acceptEdits   → 'warning'    (caution — writes auto-allowed)
 *   bypass        → 'error'      (red alert — all gates open)
 *   plan          → 'permission' (blue-purple — planning mode)
 *   default       → 'text'       (neutral)
 *   isolated      → 'inactive'   (not yet implemented, treat as inactive)
 */
export function getModeColor(mode: PermissionMode): ThemeToken {
  switch (mode) {
    case 'readonly':
      return 'inactive';
    case 'acceptEdits':
      return 'warning';
    case 'bypass':
      return 'error';
    case 'plan':
      return 'permission';
    case 'isolated':
      return 'inactive';
    case 'default':
    default:
      return 'text';
  }
}
