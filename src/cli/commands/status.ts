// status.ts — re-export shim (SPEC-828)
// Moved to src/cli/debug/status.ts. This file exists only for import-path compatibility
// during the transition. Import from ../debug/status.ts going forward.
export { runStatus, parseSinceArg } from '../debug/status.ts';
