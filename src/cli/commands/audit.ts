// audit.ts — re-export shim (SPEC-828)
// Moved to src/cli/debug/audit.ts. This file exists only for import-path compatibility
// during the transition. Import from ../debug/audit.ts going forward.
export { runAudit } from '../debug/audit.ts';
