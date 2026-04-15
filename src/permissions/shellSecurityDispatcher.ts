// shellSecurityDispatcher.ts — SPEC-303 T4: route shell command to bash/pwsh check.
// cmd.exe unsupported → fail-closed.

import { checkBashCommand, type SecurityCheckResult } from './bashSecurity.ts';
import { checkPwshCommand } from './pwshSecurity.ts';

export type Shell = 'bash' | 'pwsh' | 'cmd' | 'unknown';

export function checkShellCommand(shell: Shell, cmd: string): SecurityCheckResult {
  if (shell === 'bash') return checkBashCommand(cmd);
  if (shell === 'pwsh') return checkPwshCommand(cmd);
  return {
    ok: false,
    rule: 'TR-DANGER',
    reason: shell === 'cmd' ? 'cmd.exe unsupported' : 'unknown shell',
    threat: 'T5',
  };
}
