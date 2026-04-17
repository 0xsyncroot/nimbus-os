// vault.ts — re-export shim (SPEC-828)
// Moved to src/cli/debug/vault.ts. This file exists only for import-path compatibility
// during the transition. Import from ../debug/vault.ts going forward.
export { runVault } from '../debug/vault.ts';
