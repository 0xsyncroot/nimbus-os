// Read.ts — SPEC-302 T2: file read with offset/limit + binary guard + pathValidator.

import { z } from 'zod';
import { ErrorCode, NimbusError, wrapError } from '../../observability/errors.ts';
import {
  MAX_READ_BYTES,
  assertNotSymlink,
  assertSize,
  isBinary,
  readTextWithLineNumbers,
  resolveWorkspacePath,
  stripBom,
} from './fsHelpers.ts';
import type { Tool } from '../types.ts';

export const ReadInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(10000).optional(),
}).strict();
export type ReadInput = z.infer<typeof ReadInputSchema>;

export interface ReadOutput {
  path: string;
  totalLines: number;
  returnedLines: number;
  content: string;
}

export function createReadTool(): Tool<ReadInput, ReadOutput> {
  return {
    name: 'Read',
    description: 'Read a file from the workspace with optional line offset/limit. Returns text with line numbers.',
    readOnly: true,
    inputSchema: ReadInputSchema,
    async handler(input, ctx) {
      try {
        const abs = resolveWorkspacePath(ctx.cwd, input.path);
        await assertNotSymlink(abs);
        await assertSize(abs, MAX_READ_BYTES).catch((err) => {
          throw err;
        });
        const file = Bun.file(abs);
        const exists = await file.exists();
        if (!exists) {
          return {
            ok: false,
            error: new NimbusError(ErrorCode.T_NOT_FOUND, { path: abs }),
          };
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (isBinary(bytes)) {
          return {
            ok: false,
            error: new NimbusError(ErrorCode.T_VALIDATION, {
              reason: 'binary_file',
              path: abs,
              hint: 'use a hex/binary viewer; Read supports text only',
            }),
          };
        }
        const text = stripBom(new TextDecoder('utf-8').decode(bytes));
        const { content, totalLines, returnedLines } = readTextWithLineNumbers(text, input.offset ?? 0, input.limit);
        return {
          ok: true,
          output: { path: abs, totalLines, returnedLines, content },
          display: content,
        };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}
