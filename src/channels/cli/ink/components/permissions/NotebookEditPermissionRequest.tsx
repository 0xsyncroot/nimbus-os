// NotebookEditPermissionRequest.tsx — SPEC-846 stub for v0.4.1.
// Full implementation deferred per SPEC-846 §9 Open Questions.

import React from 'react';
import { NimbusError, ErrorCode } from '../../../../../observability/errors.ts';
import type { PermissionDialogProps } from './PermissionDialog.tsx';

export function NotebookEditPermissionRequest(_props: PermissionDialogProps): React.ReactElement {
  throw new NimbusError(ErrorCode.T_NOT_IMPLEMENTED, {
    component: 'NotebookEditPermissionRequest',
    deferredTo: 'v0.4.1',
    spec: 'SPEC-846',
  });
}
