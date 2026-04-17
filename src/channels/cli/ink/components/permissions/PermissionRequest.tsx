// PermissionRequest.tsx — SPEC-846: dispatcher mapping toolName → per-tool component.
// Unknown tool → throws NimbusError(T_VALIDATION).

import React from 'react';
import { NimbusError, ErrorCode } from '../../../../../observability/errors.ts';
import type { PermissionDialogProps } from './PermissionDialog.tsx';
import { BashPermissionRequest } from './BashPermissionRequest.tsx';
import { FileWritePermissionRequest } from './FileWritePermissionRequest.tsx';
import { FileEditPermissionRequest } from './FileEditPermissionRequest.tsx';
import { SedEditPermissionRequest } from './SedEditPermissionRequest.tsx';
import { WebFetchPermissionRequest } from './WebFetchPermissionRequest.tsx';
import { SkillPermissionRequest } from './SkillPermissionRequest.tsx';
import { NotebookEditPermissionRequest } from './NotebookEditPermissionRequest.tsx';
import { ExitPlanModePermissionRequest } from './ExitPlanModePermissionRequest.tsx';

// ── Known tool names ───────────────────────────────────────────────────────────
const KNOWN_TOOLS = new Set([
  'bash',
  'write',
  'edit',
  'sed_edit',
  'web_fetch',
  'skill',
  'notebook_edit',
  'exit_plan_mode',
]);

// ── Dispatcher ────────────────────────────────────────────────────────────────
export function PermissionRequest(props: PermissionDialogProps): React.ReactElement {
  const tool = props.toolName.toLowerCase();

  if (!KNOWN_TOOLS.has(tool)) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      toolName: props.toolName,
      reason: 'unknown_tool_for_permission_dialog',
    });
  }

  switch (tool) {
    case 'bash':
      return React.createElement(BashPermissionRequest, props);
    case 'write':
      return React.createElement(FileWritePermissionRequest, props);
    case 'edit':
      return React.createElement(FileEditPermissionRequest, props);
    case 'sed_edit':
      return React.createElement(SedEditPermissionRequest, props);
    case 'web_fetch':
      return React.createElement(WebFetchPermissionRequest, props);
    case 'skill':
      return React.createElement(SkillPermissionRequest, props);
    case 'notebook_edit':
      return React.createElement(NotebookEditPermissionRequest, props);
    case 'exit_plan_mode':
      return React.createElement(ExitPlanModePermissionRequest, props);
    default:
      // Exhaustiveness guard — all known tools handled above
      throw new NimbusError(ErrorCode.T_VALIDATION, {
        toolName: props.toolName,
        reason: 'dispatcher_fallthrough',
      });
  }
}
