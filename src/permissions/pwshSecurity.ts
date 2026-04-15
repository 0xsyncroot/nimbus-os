// pwshSecurity.ts — SPEC-303 T3: PowerShell tier-1 equivalents (TR-*P).

import { parsePwsh } from './commandParser.ts';
import type { SecurityCheckResult, SecurityRuleId } from './bashSecurity.ts';

function block(rule: SecurityRuleId, reason: string, threat: string): SecurityCheckResult {
  return { ok: false, rule, reason, threat };
}

export function checkPwshCommand(cmd: string): SecurityCheckResult {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    return { ok: false, rule: 'TR-DANGER', reason: 'empty_command', threat: 'T5' };
  }
  if (cmd.includes('\0')) {
    return { ok: false, rule: 'TR-DANGER', reason: 'null_byte', threat: 'T5' };
  }
  const p = parsePwsh(cmd);
  const flat = cmd.replace(/\s+/g, ' ');

  // TR-1P: Remove-Item -Recurse / rm -rf against root/home
  if (/Remove-Item\b[^|;]*-Recurse\b[^|;]*(?:\s|['"])\b([cC]:\\|\\|~|\$HOME|\$env:USERPROFILE)/i.test(flat)) {
    return block('TR-1P', 'Remove-Item -Recurse against root/home', 'T6');
  }
  if (/\brm\s+-rf?\s+[\/~]/i.test(flat)) {
    return block('TR-1P', 'rm -rf root/home', 'T6');
  }
  if (/Format-Volume\b/i.test(flat)) return block('TR-1P', 'Format-Volume', 'T6');
  if (/Clear-Disk\b/i.test(flat)) return block('TR-1P', 'Clear-Disk', 'T6');

  // TR-2P: iwr|iex, Invoke-WebRequest|Invoke-Expression
  if (/(?:iwr|Invoke-WebRequest|curl|wget|Invoke-RestMethod|irm)\b[^|;]*\|\s*(?:iex|Invoke-Expression)/i.test(flat)) {
    return block('TR-2P', 'iwr|iex', 'T5');
  }

  // TR-3P: ScriptBlock::Create, [scriptblock]::Create
  if (/\[(?:System\.Management\.Automation\.)?ScriptBlock\]::Create\b/i.test(flat)) {
    return block('TR-3P', 'ScriptBlock::Create', 'T5');
  }

  // TR-4P: Invoke-Expression, Add-Type, Reflection.Assembly::Load
  if (/\b(?:iex|Invoke-Expression)\b/i.test(flat)) {
    return block('TR-4P', 'Invoke-Expression', 'T5');
  }
  if (/\bAdd-Type\b/i.test(flat)) {
    return block('TR-4P', 'Add-Type dynamic', 'T5');
  }
  if (/\[(?:System\.)?Reflection\.Assembly\]::Load\b/i.test(flat)) {
    return block('TR-4P', 'Assembly::Load', 'T5');
  }

  // TR-6P: Set-ExecutionPolicy Bypass, env tampering
  if (/Set-ExecutionPolicy\b[^|;]*Bypass\b/i.test(flat)) {
    return block('TR-6P', 'ExecutionPolicy Bypass', 'T5');
  }
  if (/\$env:(?:PATH|PSModulePath|NODE_OPTIONS|PYTHONPATH)\s*=/i.test(flat)) {
    return block('TR-6P', 'env var tampering', 'T5');
  }

  // TR-7P: Start-Process -Verb RunAs
  if (/Start-Process\b[^|;]*-Verb\s+RunAs\b/i.test(flat)) {
    return block('TR-7P', 'Start-Process RunAs', 'T5');
  }

  // TR-9P: Credential paths + Credential Manager
  if (/(?:\\|\/)\.ssh(?:\\|\/)/i.test(flat)) return block('TR-9P', '.ssh access', 'T6');
  if (/(?:\\|\/)\.aws(?:\\|\/)credentials/i.test(flat)) return block('TR-9P', 'aws creds', 'T6');
  if (/Get-Credential\b/i.test(flat)) return block('TR-9P', 'Get-Credential', 'T6');
  if (/CredentialManager\b/i.test(flat)) return block('TR-9P', 'CredentialManager', 'T6');
  if (/\.(?:pfx|pem|key)\b/i.test(flat) && /Get-Content\b/i.test(flat)) {
    return block('TR-9P', 'cert read', 'T6');
  }

  // TR-11P: Persistence — Run keys, Startup folder, Scheduled tasks
  if (/HK(?:CU|LM):\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run/i.test(flat)) {
    return block('TR-11P', 'Run registry key', 'T16');
  }
  if (/Startup\\/i.test(flat) && /Programs\\/i.test(flat)) {
    return block('TR-11P', 'Startup folder', 'T16');
  }
  if (/Register-ScheduledTask\b/i.test(flat)) {
    return block('TR-11P', 'ScheduledTask', 'T16');
  }
  if (/New-Service\b/i.test(flat)) {
    return block('TR-11P', 'New-Service persistence', 'T16');
  }
  if (/\\Microsoft\\Windows\\Start Menu\\Programs\\Startup/i.test(flat)) {
    return block('TR-11P', 'Startup programs', 'T16');
  }

  void p;
  return { ok: true };
}
