// Write.ts — SPEC-302 T3: atomic write (tmp+rename) with pathValidator + chooseMode.

import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ErrorCode, NimbusError, wrapError } from '../../observability/errors.ts';
import { detect } from '../../platform/detect.ts';
import {
  MAX_WRITE_BYTES,
  assertNotSymlink,
  chooseMode,
  resolveWorkspacePath,
} from './fsHelpers.ts';
import type { Tool } from '../types.ts';

export const WriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(MAX_WRITE_BYTES),
}).strict();
export type WriteInput = z.infer<typeof WriteInputSchema>;

export interface WriteOutput {
  path: string;
  bytes: number;
}

export function createWriteTool(): Tool<WriteInput, WriteOutput> {
  return {
    name: 'Write',
    description: 'Atomically write text content to a file inside the workspace (tmp+rename). Overwrites existing content.',
    readOnly: false,
    dangerous: true,
    inputSchema: WriteInputSchema,
    async handler(input, _ctx) {
      try {
        const abs = resolveWorkspacePath(_ctx.cwd, input.path);
        await assertNotSymlink(abs);
        const dir = dirname(abs);
        await mkdir(dir, { recursive: true }).catch((err) => {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new NimbusError(ErrorCode.T_NOT_FOUND, { reason: 'parent_missing', dir });
          }
          throw err;
        });
        const tmp = abs + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 8);
        const bytes = Buffer.byteLength(input.content, 'utf8');
        const mode = chooseMode(abs);
        try {
          await writeFile(tmp, input.content, { encoding: 'utf8', mode });
          await rename(tmp, abs);
          if (detect().os !== 'win32') {
            await chmod(abs, mode).catch(() => undefined);
          }
        } catch (err) {
          await unlink(tmp).catch(() => undefined);
          throw err;
        }
        return {
          ok: true,
          output: { path: abs, bytes },
          display: `wrote ${bytes} bytes to ${abs}`,
        };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}
