// commandParser.ts — SPEC-303 T1: POSIX/pwsh command parser for security rules.

import { parse as posixParse } from 'shell-quote';

export interface ParsedCommand {
  shell: 'bash' | 'pwsh';
  raw: string;
  tokens: Array<string | { op: string }>;
  subshells: string[];
  pipes: string[][];
  redirects: Array<{ op: string; target: string }>;
  processSub: string[];
  interpreterArgs: Array<{ interp: string; flag: string; body: string }>;
  envAssignments: Array<{ name: string; value: string }>;
  heredocs: Array<{ interp: string; body: string }>;
  hereStrings: Array<{ interp: string; body: string }>;
  braceExpansion: string[];
  parameterExpansion: Array<{ name: string; default?: string }>;
  hasBackticks: boolean;
  hasSudo: boolean;
  hasCommandSub: boolean;
  commands: string[];
}

const INTERPRETERS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'ksh', 'dash', 'ash',
  'python', 'python2', 'python3',
  'node', 'nodejs', 'deno', 'bun',
  'perl', 'ruby', 'php', 'lua',
]);

export function parseBash(cmd: string): ParsedCommand {
  const out: ParsedCommand = baseParse(cmd, 'bash');

  // Subshells $(...) and backticks. Use regex sweep on raw.
  const subs: string[] = [];
  const subRe = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = subRe.exec(cmd)) !== null) subs.push(m[1] ?? '');
  const backRe = /`([^`]*)`/g;
  while ((m = backRe.exec(cmd)) !== null) {
    subs.push(m[1] ?? '');
    out.hasBackticks = true;
  }
  out.subshells = subs;
  out.hasCommandSub = subs.length > 0;

  // Process substitution <() >()
  const procRe = /[<>]\(([^()]*)\)/g;
  while ((m = procRe.exec(cmd)) !== null) out.processSub.push(m[1] ?? '');

  // Brace expansion {a,b,c}
  const braceRe = /\{[^{}]*,[^{}]*\}/g;
  const braces = cmd.match(braceRe);
  if (braces) out.braceExpansion = braces;

  // Parameter expansion ${X:-default} ${X:=..} ${X:+..}
  const paramRe = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[-+=?]([^}]*))?\}/g;
  while ((m = paramRe.exec(cmd)) !== null) {
    const entry: { name: string; default?: string } = { name: m[1] ?? '' };
    if (m[2] !== undefined) entry.default = m[2];
    out.parameterExpansion.push(entry);
  }

  // Heredoc  cmd <<EOF ... EOF  and here-string cmd <<<"body"
  const heredocRe = /(\S+)\s*<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?([\s\S]*?)\n\2\b/g;
  while ((m = heredocRe.exec(cmd)) !== null) {
    out.heredocs.push({ interp: m[1] ?? '', body: m[3] ?? '' });
  }
  const hereStrRe = /(\S+)\s*<<<\s*(['"]?)([\s\S]*?)\2(?=\s|$|[;&|])/g;
  while ((m = hereStrRe.exec(cmd)) !== null) {
    out.hereStrings.push({ interp: m[1] ?? '', body: m[3] ?? '' });
  }

  // Tokens via shell-quote
  try {
    const raw = posixParse(cmd);
    const tokens: Array<string | { op: string }> = [];
    for (const t of raw) {
      if (typeof t === 'string') tokens.push(t);
      else if (typeof t === 'object' && t !== null && 'op' in t) {
        tokens.push({ op: String((t as { op: unknown }).op) });
      } else if (typeof t === 'object' && t !== null && 'pattern' in t) {
        tokens.push(String((t as { pattern: unknown }).pattern));
      }
    }
    out.tokens = tokens;
  } catch {
    // Malformed quoting — still run regex-based checks.
    out.tokens = cmd.split(/\s+/);
  }

  // Pipes — split tokens by pipe op.
  const pipes: string[][] = [];
  let cur: string[] = [];
  for (const t of out.tokens) {
    if (typeof t === 'object' && (t.op === '|' || t.op === '|&')) {
      pipes.push(cur);
      cur = [];
    } else if (typeof t === 'string') {
      cur.push(t);
    }
  }
  pipes.push(cur);
  out.pipes = pipes;

  // Env assignments + interpreter args + commands
  for (let pi = 0; pi < pipes.length; pi++) {
    const seg = pipes[pi]!;
    let inEnv = true;
    let cmdIdx = -1;
    for (let i = 0; i < seg.length; i++) {
      const tok = seg[i]!;
      if (inEnv) {
        const am = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (am) {
          out.envAssignments.push({ name: am[1]!, value: am[2]! });
          continue;
        }
        inEnv = false;
        cmdIdx = i;
      }
      break;
    }
    if (cmdIdx >= 0) {
      const cmdName = basename(seg[cmdIdx]!);
      out.commands.push(cmdName);
      if (cmdName === 'sudo' || cmdName === 'doas' || cmdName === 'pkexec' || cmdName === 'su') {
        out.hasSudo = true;
      }
      if (INTERPRETERS.has(cmdName)) {
        for (let j = cmdIdx + 1; j < seg.length; j++) {
          const arg = seg[j]!;
          if (arg === '-c' || arg === '-e' || arg === '--command') {
            out.interpreterArgs.push({ interp: cmdName, flag: arg, body: seg[j + 1] ?? '' });
            break;
          }
        }
      }
      if (cmdName === 'eval' || cmdName === 'source' || cmdName === '.') {
        out.interpreterArgs.push({ interp: cmdName, flag: '', body: seg.slice(cmdIdx + 1).join(' ') });
      }
    }
  }

  // Redirects
  for (let i = 0; i < out.tokens.length; i++) {
    const t = out.tokens[i];
    if (typeof t === 'object' && (t.op === '>' || t.op === '>>' || t.op === '<' || t.op === '2>' || t.op === '&>' )) {
      const next = out.tokens[i + 1];
      if (typeof next === 'string') out.redirects.push({ op: t.op, target: next });
    }
  }

  return out;
}

export function parsePwsh(cmd: string): ParsedCommand {
  const out: ParsedCommand = baseParse(cmd, 'pwsh');
  // pwsh tokenizer: split by whitespace, preserve quoted.
  const tokens: Array<string | { op: string }> = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    tokens.push((m[1] ?? m[2] ?? m[3] ?? ''));
  }
  out.tokens = tokens;

  // Commands on each | segment
  const pipes: string[][] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if (typeof t === 'string') {
      if (t === '|') {
        pipes.push(cur);
        cur = [];
      } else {
        cur.push(t);
      }
    }
  }
  pipes.push(cur);
  out.pipes = pipes;
  for (const seg of pipes) {
    if (seg.length > 0) out.commands.push(basename(seg[0]!));
  }
  return out;
}

function baseParse(raw: string, shell: 'bash' | 'pwsh'): ParsedCommand {
  return {
    shell,
    raw,
    tokens: [],
    subshells: [],
    pipes: [],
    redirects: [],
    processSub: [],
    interpreterArgs: [],
    envAssignments: [],
    heredocs: [],
    hereStrings: [],
    braceExpansion: [],
    parameterExpansion: [],
    hasBackticks: false,
    hasSudo: false,
    hasCommandSub: false,
    commands: [],
  };
}

function basename(p: string): string {
  const s = p.split(/[\\/]/).pop() ?? p;
  return s.toLowerCase();
}
