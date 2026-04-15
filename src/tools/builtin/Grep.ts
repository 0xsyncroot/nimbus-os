// Grep.ts — SPEC-302 T5: ripgrep-like search via Bun.spawn rg with JS fallback.

import { readdir, stat } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { ErrorCode, NimbusError, wrapError } from '../../observability/errors.ts';
import { validatePath } from '../../permissions/pathValidator.ts';
import { MAX_GREP_BYTES, redactSecrets } from './fsHelpers.ts';
import type { Tool } from '../types.ts';

export const GrepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  mode: z.enum(['files_with_matches', 'content', 'count']).default('files_with_matches'),
  caseInsensitive: z.boolean().default(false),
  headLimit: z.number().int().positive().max(10000).default(250),
}).strict();
export type GrepInput = z.infer<typeof GrepInputSchema>;

export interface GrepOutput {
  mode: GrepInput['mode'];
  resultsCount: number;
  text: string;
  engine: 'rg' | 'js';
}

export interface GrepDeps {
  rgPath?: string | null;
}

let rgPathCache: string | null | undefined;

async function resolveRgPath(): Promise<string | null> {
  if (rgPathCache !== undefined) return rgPathCache;
  try {
    const which = (Bun as unknown as { which?: (b: string) => string | null }).which;
    if (typeof which === 'function') {
      const p = which('rg');
      if (p && isTrustedPath(p)) {
        rgPathCache = p;
        return p;
      }
    }
  } catch {
    // ignore
  }
  rgPathCache = null;
  return null;
}

function isTrustedPath(p: string): boolean {
  const home = process.env['HOME'] ?? '';
  const tmp = process.env['TMPDIR'] ?? '/tmp';
  if (home && p.startsWith(home + '/')) return false;
  if (p.startsWith(tmp + '/')) return false;
  return true;
}

export function createGrepTool(deps: GrepDeps = {}): Tool<GrepInput, GrepOutput> {
  return {
    name: 'Grep',
    description: 'Search file contents via ripgrep (with JS fallback). Modes: files_with_matches | content | count.',
    readOnly: true,
    inputSchema: GrepInputSchema,
    async handler(input, ctx) {
      try {
        const searchRoot = input.path
          ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
          : ctx.cwd;
        validatePath(searchRoot, ctx.cwd);

        const rgPath = deps.rgPath !== undefined ? deps.rgPath : await resolveRgPath();
        if (rgPath) {
          return await runRg(rgPath, searchRoot, input, ctx.signal);
        }
        return await runJsFallback(searchRoot, input);
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}

async function runRg(
  rgPath: string,
  searchRoot: string,
  input: GrepInput,
  signal: AbortSignal,
): Promise<{ ok: true; output: GrepOutput; display: string }> {
  const args: string[] = ['--no-heading', '--color=never'];
  if (input.caseInsensitive) args.push('-i');
  if (input.mode === 'files_with_matches') args.push('-l');
  else if (input.mode === 'count') args.push('-c');
  else args.push('-n');
  if (input.glob) args.push('-g', input.glob);
  args.push('--', input.pattern, searchRoot);
  const proc = Bun.spawn([rgPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const redacted = redactSecrets(stdout);
  const lines = redacted.split('\n').filter((l) => l.length > 0).slice(0, input.headLimit);
  const out = lines.join('\n');
  return {
    ok: true,
    output: { mode: input.mode, resultsCount: lines.length, text: out, engine: 'rg' },
    display: out || '(no matches)',
  };
}

async function runJsFallback(
  searchRoot: string,
  input: GrepInput,
): Promise<{ ok: true; output: GrepOutput; display: string }> {
  const re = new RegExp(input.pattern, input.caseInsensitive ? 'i' : '');
  const globRe = input.glob ? globToRegExp(input.glob) : null;
  const files: string[] = [];
  await walk(searchRoot, files, 0);
  const out: string[] = [];
  let count = 0;
  for (const f of files) {
    if (globRe && !globRe.test(f)) continue;
    try {
      const st = await stat(f);
      if (st.size > MAX_GREP_BYTES) continue;
      const text = await Bun.file(f).text();
      if (input.mode === 'files_with_matches') {
        if (re.test(text)) {
          out.push(f);
          count++;
        }
      } else if (input.mode === 'count') {
        const lines = text.split('\n').filter((l) => re.test(l));
        if (lines.length > 0) {
          out.push(`${f}:${lines.length}`);
          count += lines.length;
        }
      } else {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            out.push(`${f}:${i + 1}:${lines[i]}`);
            count++;
            if (out.length >= input.headLimit) break;
          }
        }
      }
    } catch {
      // skip unreadable
    }
    if (out.length >= input.headLimit) break;
  }
  const redacted = redactSecrets(out.join('\n'));
  return {
    ok: true,
    output: { mode: input.mode, resultsCount: count, text: redacted, engine: 'js' },
    display: redacted || '(no matches)',
  };
}

async function walk(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 12) return;
  if (out.length > 20000) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, depth + 1);
    else if (e.isFile()) out.push(p);
  }
}

function globToRegExp(glob: string): RegExp {
  // Only support simple * and ? wildcards; no {} or brace expansion.
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(re + '$');
}
