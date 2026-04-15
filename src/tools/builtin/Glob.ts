// Glob.ts — SPEC-302 T6: glob pattern match via Bun.Glob.

import { readdir, stat } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { NimbusError, wrapError } from '../../observability/errors.ts';
import { validatePath } from '../../permissions/pathValidator.ts';
import type { Tool } from '../types.ts';

export const GlobInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
}).strict();
export type GlobInput = z.infer<typeof GlobInputSchema>;

export interface GlobOutput {
  matches: string[];
  count: number;
}

const MAX_RESULTS = 10000;

export function createGlobTool(): Tool<GlobInput, GlobOutput> {
  return {
    name: 'Glob',
    description: 'Glob-match files under a directory (default: workspace cwd). Returns paths sorted by mtime desc.',
    readOnly: true,
    inputSchema: GlobInputSchema,
    async handler(input, ctx) {
      try {
        const searchRoot = input.path
          ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
          : ctx.cwd;
        validatePath(searchRoot, ctx.cwd);
        const paths = await runGlob(searchRoot, input.pattern);
        // mtime sort desc
        const stamped: Array<{ p: string; m: number }> = [];
        for (const p of paths) {
          try {
            const st = await stat(p);
            stamped.push({ p, m: st.mtimeMs });
          } catch {
            stamped.push({ p, m: 0 });
          }
        }
        stamped.sort((a, b) => b.m - a.m);
        const matches = stamped.slice(0, MAX_RESULTS).map((x) => x.p);
        return {
          ok: true,
          output: { matches, count: matches.length },
          display: matches.join('\n'),
        };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}

async function runGlob(root: string, pattern: string): Promise<string[]> {
  const BunGlob = (Bun as unknown as { Glob?: new (p: string) => { scan: (opts: { cwd: string; onlyFiles: boolean }) => AsyncIterable<string> } }).Glob;
  if (BunGlob) {
    const g = new BunGlob(pattern);
    const out: string[] = [];
    for await (const p of g.scan({ cwd: root, onlyFiles: true })) {
      out.push(join(root, p));
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }
  // Fallback: recursive walk with simple matcher.
  const re = globToRegExp(pattern);
  const files: string[] = [];
  await walk(root, '', files, re, 0);
  return files;
}

async function walk(root: string, rel: string, out: string[], re: RegExp, depth: number): Promise<void> {
  if (depth > 16 || out.length >= MAX_RESULTS) return;
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const relChild = rel ? `${rel}/${e.name}` : e.name;
    const abs = join(root, relChild);
    if (e.isDirectory()) await walk(root, relChild, out, re, depth + 1);
    else if (e.isFile() && re.test(relChild)) out.push(abs);
  }
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE::/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp('^' + re + '$');
}
