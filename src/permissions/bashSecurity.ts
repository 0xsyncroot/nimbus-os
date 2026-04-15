// bashSecurity.ts — SPEC-303 T2: 12 tier-1 bash security rules (TR-1…TR-12).
// All checks pure functions. Pre-spawn gate. Hard block, no confirm bypass.

import { parseBash, type ParsedCommand } from './commandParser.ts';

export type SecurityRuleId =
  | 'TR-1' | 'TR-2' | 'TR-3' | 'TR-4' | 'TR-5' | 'TR-6'
  | 'TR-7' | 'TR-8' | 'TR-9' | 'TR-10' | 'TR-11' | 'TR-12'
  | 'TR-1P' | 'TR-2P' | 'TR-3P' | 'TR-4P' | 'TR-6P' | 'TR-7P' | 'TR-9P' | 'TR-11P'
  | 'TR-DANGER';

export interface SecurityCheckResult {
  ok: boolean;
  rule?: SecurityRuleId;
  reason?: string;
  threat?: string;
}

const OK: SecurityCheckResult = { ok: true };

function block(rule: SecurityRuleId, reason: string, threat: string): SecurityCheckResult {
  return { ok: false, rule, reason, threat };
}

// TR-1: Root/home destructive delete + misc destructive (dd, mkfs, shutdown).
function checkTR1(cmd: string, p: ParsedCommand): SecurityCheckResult | null {
  const flat = cmd.replace(/\s+/g, ' ');
  // rm with -r and root/home target
  if (/\brm\s+(-[rRfdvi]+\s+)*-?-?[a-z-]*\s*(\/|~|\$HOME|\$\{HOME\}?)(\s|$)/i.test(flat)) {
    if (/\brm\b/.test(flat) && /(-r|--recursive)/.test(flat) && /(-f|--force)/.test(flat)) {
      if (/\s(\/|~|\$HOME)(\s|$|\/)/i.test(flat)) {
        return block('TR-1', 'rm -rf against root or home', 'T6');
      }
    }
  }
  if (/\brm\s+.*-rf?\s+[\/~]/i.test(flat) || /\brm\s+.*-rf?\s+\$HOME\b/i.test(flat)) {
    return block('TR-1', 'rm -rf root/home', 'T6');
  }
  if (/\brm\s+.*--no-preserve-root\b/.test(flat)) {
    return block('TR-1', 'rm --no-preserve-root', 'T6');
  }
  // dd to block device
  if (/\bdd\b.*\bof=\/dev\/(sd[a-z]|nvme|disk|hd[a-z]|mmcblk)/i.test(flat)) {
    return block('TR-DANGER', 'dd to block device', 'T6');
  }
  // mkfs
  if (/\bmkfs(\.|\s)/i.test(flat)) {
    return block('TR-DANGER', 'mkfs', 'T6');
  }
  // shutdown/reboot/halt/poweroff
  if (/\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i.test(flat)) {
    return block('TR-DANGER', 'system shutdown', 'T7');
  }
  // chmod 777 -R /
  if (/\bchmod\s+.*(-R|--recursive).*\s(\/|~)(\s|$)/i.test(flat)) {
    return block('TR-DANGER', 'chmod -R /', 'T6');
  }
  // systemctl destructive
  if (/\bsystemctl\s+(disable|stop|mask)\b/i.test(flat)) {
    return block('TR-DANGER', 'systemctl destructive', 'T7');
  }
  // Backslash line-continuation hiding rm -rf
  const collapsed = cmd.replace(/\\\r?\n/g, '');
  if (collapsed !== cmd) {
    const r = checkTR1(collapsed, parseBash(collapsed));
    if (r) return r;
  }
  // Quote splicing: r"m -rf /", 'rm'' -rf /' etc. Normalize by removing quote pairs.
  const dequoted = cmd.replace(/['"]/g, '');
  if (dequoted !== cmd && /rm\s+-rf?\s+[\/~]/.test(dequoted)) {
    return block('TR-1', 'quote-spliced rm -rf', 'T6');
  }
  void p;
  return null;
}

// TR-2: Pipe curl/wget to shell.
function checkTR2(cmd: string, p: ParsedCommand): SecurityCheckResult | null {
  const flat = cmd.replace(/\s+/g, ' ');
  // curl ... | sh|bash|zsh|python
  if (/\b(curl|wget|fetch|aria2c|http)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|ksh|dash|python3?|node|bun|perl|ruby)\b/i.test(flat)) {
    return block('TR-2', 'curl|sh pattern', 'T5');
  }
  // base64 | bash ; xxd ... | bash ; printf ... | bash
  if (/\b(base64|xxd|od|openssl)\b[^|]*\|\s*(sh|bash|zsh|python3?|node)\b/i.test(flat)) {
    return block('TR-2', 'decode|interp pipe', 'T5');
  }
  // echo/printf $'...' | sh
  if (/\b(echo|printf)\b[^|]*\|\s*(sh|bash|zsh)\b/i.test(flat)) {
    return block('TR-2', 'echo|sh pipe', 'T5');
  }
  // Inspect pipes from parser as fallback.
  for (let i = 0; i + 1 < p.pipes.length; i++) {
    const left = p.pipes[i]!.join(' ').toLowerCase();
    const rightCmd = (p.pipes[i + 1]![0] ?? '').toLowerCase();
    const baseRight = rightCmd.split(/[\\/]/).pop() ?? '';
    if (/^(curl|wget|fetch|aria2c)$/.test(basenameOf(left)) && /^(sh|bash|zsh|python3?|node|bun|perl|ruby)$/.test(baseRight)) {
      return block('TR-2', 'parser: download|interp', 'T5');
    }
  }
  return null;
}

function basenameOf(seg: string): string {
  const first = seg.trim().split(/\s+/)[0] ?? '';
  return (first.split(/[\\/]/).pop() ?? '').toLowerCase();
}

// TR-3: Command substitution, expansion evasion.
function checkTR3(cmd: string, p: ParsedCommand): SecurityCheckResult | null {
  // $(...) and backticks
  if (p.hasCommandSub || p.hasBackticks) {
    return block('TR-3', 'command substitution', 'T5');
  }
  // Brace expansion like {rm,-rf,/}
  for (const b of p.braceExpansion) {
    if (/rm|bash|sh|curl|wget|eval/i.test(b)) {
      return block('TR-3', 'brace expansion masking', 'T5');
    }
  }
  // Parameter expansion with defaults containing dangerous words
  for (const pe of p.parameterExpansion) {
    if (pe.default && /(rm|bash|sh|curl|wget|eval|sudo)/i.test(pe.default)) {
      return block('TR-3', 'parameter default injection', 'T5');
    }
  }
  // Unicode/hex escapes used to hide characters — $'\x72\x6d' etc.
  if (/\$'[^']*\\x[0-9a-fA-F]{2}[^']*'/.test(cmd)) {
    return block('TR-3', 'ansi-c hex escape', 'T5');
  }
  if (/\$'[^']*\\u[0-9a-fA-F]{4}[^']*'/.test(cmd)) {
    return block('TR-3', 'ansi-c unicode escape', 'T5');
  }
  // env-assign + immediate var use: X=curl ... ; $X sh
  for (const env of p.envAssignments) {
    for (const seg of p.pipes) {
      for (const tok of seg) {
        if (tok.includes('$' + env.name) || tok.includes('${' + env.name + '}')) {
          return block('TR-3', 'env-assign var-use bypass', 'T5');
        }
      }
    }
  }
  // Supplemental raw scan: a=rm ... $a usage across statement separators.
  const varRe = /(?:^|[\s;&|])([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))/g;
  let vm: RegExpExecArray | null;
  while ((vm = varRe.exec(cmd)) !== null) {
    const name = vm[1]!;
    const value = vm[2] ?? vm[3] ?? vm[4] ?? '';
    if (/^(rm|bash|sh|zsh|curl|wget|eval|sudo|python3?|node|dd|mkfs)$/i.test(value)) {
      const refRe = new RegExp('\\$\\{?' + name + '\\b');
      if (refRe.test(cmd)) {
        return block('TR-3', 'env-assign var-use cross-statement', 'T5');
      }
    }
  }
  return null;
}

// TR-4: Interpreter -c/-e, eval, source, heredoc.
function checkTR4(_cmd: string, p: ParsedCommand): SecurityCheckResult | null {
  for (const ia of p.interpreterArgs) {
    if (ia.flag === '-c' || ia.flag === '-e' || ia.flag === '--command') {
      return block('TR-4', `${ia.interp} ${ia.flag}`, 'T5');
    }
    if (ia.interp === 'eval') {
      return block('TR-4', 'eval', 'T5');
    }
    if (ia.interp === 'source' || ia.interp === '.') {
      if (/(\/tmp\/|\/dev\/|http|:\/\/|\/var\/tmp\/)/i.test(ia.body)) {
        return block('TR-4', 'source from untrusted path', 'T5');
      }
      return block('TR-4', 'source', 'T5');
    }
  }
  if (p.heredocs.length > 0) {
    for (const hd of p.heredocs) {
      const base = (hd.interp.split(/[\\/]/).pop() ?? '').toLowerCase();
      if (/^(bash|sh|zsh|python3?|node|bun|perl|ruby)$/.test(base)) {
        return block('TR-4', 'heredoc to interpreter', 'T5');
      }
    }
  }
  if (p.hereStrings.length > 0) {
    for (const hs of p.hereStrings) {
      const base = (hs.interp.split(/[\\/]/).pop() ?? '').toLowerCase();
      if (/^(bash|sh|zsh|python3?|node|bun|perl|ruby)$/.test(base)) {
        return block('TR-4', 'here-string to interpreter', 'T5');
      }
    }
  }
  return null;
}

// TR-5: Fork bomb.
function checkTR5(cmd: string): SecurityCheckResult | null {
  const flat = cmd.replace(/\s+/g, '');
  if (/:\(\)\{:\|:&\};:/.test(flat)) return block('TR-5', 'fork bomb', 'T7');
  // Variants: `bomb(){ bomb|bomb& }; bomb`
  if (/([A-Za-z_]\w*)\(\)\{[^}]*\1\s*\|\s*\1\s*&[^}]*\};\s*\1/.test(cmd)) {
    return block('TR-5', 'recursive fork bomb', 'T7');
  }
  return null;
}

// TR-6: Env injection.
const DANGEROUS_ENVS = new Set([
  'IFS', 'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP',
  'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'GIT_SSH_COMMAND',
]);
function checkTR6(_cmd: string, p: ParsedCommand): SecurityCheckResult | null {
  for (const env of p.envAssignments) {
    if (DANGEROUS_ENVS.has(env.name)) {
      return block('TR-6', `env inject ${env.name}`, 'T5');
    }
  }
  return null;
}

// TR-7: Privilege escalation.
function checkTR7(_cmd: string, p: ParsedCommand): SecurityCheckResult | null {
  if (p.hasSudo) return block('TR-7', 'sudo/su/doas/pkexec', 'T5');
  for (const c of p.commands) {
    if (c === 'sudo' || c === 'doas' || c === 'pkexec' || c === 'su') {
      return block('TR-7', 'privilege escalation', 'T5');
    }
  }
  return null;
}

// TR-8: Process substitution.
function checkTR8(_cmd: string, p: ParsedCommand): SecurityCheckResult | null {
  if (p.processSub.length > 0) return block('TR-8', 'process substitution', 'T5');
  return null;
}

// TR-9: Credential path access.
const CRED_PATTERNS: RegExp[] = [
  /\.ssh\//i,
  /\.env(\s|$|\/|:|'|")/i,
  /\.env\.[\w.-]+/i,
  /\.aws\/credentials/i,
  /\.aws\/config/i,
  /\.gnupg\//i,
  /\.netrc\b/i,
  /\.docker\/config\.json/i,
  /\.kube\/config/i,
  /\.npmrc\b/i,
  /\.pypirc\b/i,
  /\/etc\/shadow\b/i,
  /\/etc\/passwd\b/i,
  /\/etc\/gshadow\b/i,
  /\.bashrc\b/i,
  /\.zshrc\b/i,
  /\.bash_profile\b/i,
  /\.zprofile\b/i,
  /\.profile\b/i,
  /secrets\.enc\b/i,
  /id_rsa\b/i,
  /id_ed25519\b/i,
];
function checkTR9(cmd: string, _p: ParsedCommand): SecurityCheckResult | null {
  for (const re of CRED_PATTERNS) {
    if (re.test(cmd)) {
      return block('TR-9', `sensitive path (${re.source})`, 'T6');
    }
  }
  return null;
}

// TR-10: Cloud metadata.
const METADATA_PATTERNS: RegExp[] = [
  /\b169\.254\.169\.254\b/,
  /\bfd00:ec2::254\b/i,
  /\bmetadata\.google(?:apis)?\.internal\b/i,
  /\bmetadata\.azure\.com\b/i,
  /\bmetadata\.oraclecloud\.com\b/i,
  /\b100\.100\.100\.200\b/,
];
function checkTR10(cmd: string, _p: ParsedCommand): SecurityCheckResult | null {
  for (const re of METADATA_PATTERNS) {
    if (re.test(cmd)) return block('TR-10', 'cloud metadata endpoint', 'T8');
  }
  return null;
}

// TR-11: Persistence paths.
const PERSISTENCE_PATTERNS: RegExp[] = [
  /\.bashrc\b/i,
  /\.zshrc\b/i,
  /\.profile\b/i,
  /\.bash_profile\b/i,
  /\.zprofile\b/i,
  /\.bash_login\b/i,
  /\.zshenv\b/i,
  /\.zlogin\b/i,
  /\/etc\/crontab\b/i,
  /\/etc\/cron\.(d|daily|hourly|weekly|monthly)\b/i,
  /\/var\/spool\/cron\b/i,
  /\/etc\/systemd\/system\b/i,
  /~?\/?\.config\/systemd\/user\b/i,
  /~?\/?Library\/LaunchAgents\b/i,
  /~?\/?Library\/LaunchDaemons\b/i,
  /\/etc\/rc\.local\b/i,
  /\/etc\/profile\.d\b/i,
  /\/etc\/init\.d\b/i,
];
function checkTR11(cmd: string, p: ParsedCommand): SecurityCheckResult | null {
  // Only block when there's an apparent write (echo/cat/tee to, redirect, chmod +x, touch).
  const writesLike = /(\becho\b|\bprintf\b|\bcat\b|\btee\b|\btouch\b|\binstall\b|\bcp\b|\bmv\b|>>|>|\bln\s)/i.test(cmd);
  // Redirect target check regardless of writesLike heuristic.
  for (const re of PERSISTENCE_PATTERNS) {
    if (re.test(cmd) && (writesLike || p.redirects.some((r) => re.test(r.target)))) {
      return block('TR-11', `persistence path (${re.source})`, 'T16');
    }
  }
  return null;
}

// TR-12: Audit-log tampering.
function checkTR12(cmd: string, _p: ParsedCommand): SecurityCheckResult | null {
  if (/(~|\$HOME)\/\.nimbus\/(logs|audit)\b/i.test(cmd)) {
    return block('TR-12', 'nimbus audit path', 'T15');
  }
  if (/\.nimbus\/workspaces\/[^/]+\/sessions\/.+\.jsonl\b/i.test(cmd)) {
    return block('TR-12', 'session jsonl', 'T15');
  }
  if (/Library\/Logs\/nimbus\b/i.test(cmd)) {
    return block('TR-12', 'macOS nimbus log', 'T15');
  }
  return null;
}

const CHECKS: Array<(cmd: string, p: ParsedCommand) => SecurityCheckResult | null> = [
  checkTR1,
  checkTR2,
  checkTR3,
  checkTR4,
  (c) => checkTR5(c),
  checkTR6,
  checkTR7,
  checkTR8,
  // TR-11 before TR-9: persistence writes (T16) take precedence over cred-read match
  // when both patterns overlap (e.g., `.bashrc` is both a cred path and a persistence target).
  checkTR11,
  checkTR9,
  checkTR10,
  checkTR12,
];

export function checkBashCommand(cmd: string): SecurityCheckResult {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    return { ok: false, rule: 'TR-DANGER', reason: 'empty_command', threat: 'T5' };
  }
  if (cmd.includes('\0')) {
    return { ok: false, rule: 'TR-DANGER', reason: 'null_byte', threat: 'T5' };
  }
  const parsed = parseBash(cmd);
  for (const check of CHECKS) {
    const r = check(cmd, parsed);
    if (r) return r;
  }
  return OK;
}
