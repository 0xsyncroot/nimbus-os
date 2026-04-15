// Edit.ts — SPEC-302 T4: exact-string find+replace with unique-match enforcement.

import { chmod, rename, unlink, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { ErrorCode, NimbusError, wrapError } from '../../observability/errors.ts';
import { detect } from '../../platform/detect.ts';
import {
  MAX_READ_BYTES,
  assertNotSymlink,
  assertSize,
  chooseMode,
  resolveWorkspacePath,
  stripBom,
} from './fsHelpers.ts';
import type { Tool } from '../types.ts';

export const EditInputSchema = z.object({
  path: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().default(false),
}).strict();
export type EditInput = z.infer<typeof EditInputSchema>;

export interface EditOutput {
  path: string;
  replacements: number;
  bytesWritten: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

export function createEditTool(): Tool<EditInput, EditOutput> {
  return {
    name: 'Edit',
    description: 'Edit file by replacing an exact string. old_string must appear once unless replaceAll=true. Atomic write.',
    readOnly: false,
    inputSchema: EditInputSchema,
    async handler(input, ctx) {
      try {
        const abs = resolveWorkspacePath(ctx.cwd, input.path);
        await assertNotSymlink(abs);
        await assertSize(abs, MAX_READ_BYTES);
        const file = Bun.file(abs);
        if (!(await file.exists())) {
          return { ok: false, error: new NimbusError(ErrorCode.T_NOT_FOUND, { path: abs }) };
        }
        const text = stripBom(await file.text());
        const count = countOccurrences(text, input.oldString);
        if (count === 0) {
          return {
            ok: false,
            error: new NimbusError(ErrorCode.T_VALIDATION, {
              reason: 'old_string_not_found',
              path: abs,
            }),
          };
        }
        if (count > 1 && !input.replaceAll) {
          return {
            ok: false,
            error: new NimbusError(ErrorCode.T_VALIDATION, {
              reason: 'old_string_non_unique',
              count,
              hint: 'add more context to oldString or set replaceAll:true',
            }),
          };
        }
        const out = input.replaceAll
          ? replaceAll(text, input.oldString, input.newString)
          : text.replace(input.oldString, input.newString);
        const tmp = abs + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 8);
        const mode = chooseMode(abs);
        try {
          await writeFile(tmp, out, { encoding: 'utf8', mode });
          await rename(tmp, abs);
          if (detect().os !== 'win32') {
            await chmod(abs, mode).catch(() => undefined);
          }
        } catch (err) {
          await unlink(tmp).catch(() => undefined);
          throw err;
        }
        const bytesWritten = Buffer.byteLength(out, 'utf8');
        const replacements = input.replaceAll ? count : 1;
        return {
          ok: true,
          output: { path: abs, replacements, bytesWritten },
          display: `edited ${abs} — ${replacements} replacement(s)`,
        };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}
