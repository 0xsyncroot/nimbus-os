// health.ts — re-export shim (SPEC-828)
// Moved to src/cli/debug/health.ts. This file exists only for import-path compatibility
// during the transition. Import from ../debug/health.ts going forward.
export { runHealth } from '../debug/health.ts';
