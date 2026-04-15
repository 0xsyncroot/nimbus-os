// tests/tools/helpers.ts — shared ToolContext stub.

import { logger } from '../../src/observability/logger.ts';
import type { Gate } from '../../src/permissions/gate.ts';
import type { ToolContext } from '../../src/tools/types.ts';

function allowGate(): Gate {
  return {
    async canUseTool() { return 'allow' as const; },
    rememberAllow() { /* noop */ },
    forgetSession() { /* noop */ },
  };
}

export function ctxStub(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    workspaceId: 'W1',
    sessionId: '01HVW3CTEST0000000000000000',
    turnId: 'T1',
    toolUseId: 'U1',
    cwd: '/tmp',
    signal: ctrl.signal,
    onAbort: () => { /* noop */ },
    permissions: allowGate(),
    mode: 'default',
    logger,
    ...overrides,
  };
}
