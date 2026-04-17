// index.ts — SPEC-830: barrel re-export for core/ui.
// Import path: import { ... } from '../core/ui/index.ts'

export type { UIIntent, UIContext, UIResult } from './intent.ts';
export {
  uiIntentSchema,
  uiIntentConfirmSchema,
  uiIntentPickSchema,
  uiIntentInputSchema,
  uiIntentStatusSchema,
  assertExhaustiveIntent,
} from './intent.ts';
export type { UIHost } from './uiHost.ts';
export { NullUIHost } from './uiHost.ts';
