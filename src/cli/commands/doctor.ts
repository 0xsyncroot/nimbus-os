// doctor.ts — re-export shim (SPEC-828)
// Moved to src/cli/debug/doctor.ts. This file exists only for import-path compatibility
// during the transition. Import from ../debug/doctor.ts going forward.
export { runDoctor } from '../debug/doctor.ts';
