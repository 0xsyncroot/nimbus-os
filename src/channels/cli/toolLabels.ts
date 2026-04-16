// toolLabels.ts — SPEC-826: channel-layer re-export + ToolEventView type.
// Core mapping lives in src/core/toolLabels.ts (importable by loop.ts).
// This file exposes everything channels need in one import.

export type { Locale } from '../../core/toolLabels.ts';
export {
  detectLocale,
  formatToolLabel,
  humanizeToolInvocation,
} from '../../core/toolLabels.ts';

export type ToolState = 'running' | 'ok' | 'error';

export interface ToolEventView {
  humanLabel: string;
  state: ToolState;
  /** 'ok': optional success detail (e.g. "1.2 KB"); 'error': friendly sentence from formatToolError */
  detail?: string;
}
