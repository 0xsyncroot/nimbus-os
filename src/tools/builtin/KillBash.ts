// KillBash.ts — SPEC-308 T5: terminate a background shell task (SIGTERM → SIGKILL after 5s).

import { z } from 'zod';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { getShellTaskRegistry } from '../../core/shellTaskRegistry.ts';
import type { Tool } from '../types.ts';

export const KillBashInputSchema = z.object({
  taskId: z.string().uuid(),
}).strict();
export type KillBashInput = z.infer<typeof KillBashInputSchema>;

export interface KillBashResult {
  taskId: string;
  status: 'killed';
}

const SIGKILL_GRACE_MS = 5_000;

export function createKillBashTool(): Tool<KillBashInput, KillBashResult> {
  return {
    name: 'KillBash',
    description: 'Terminate a background shell task. Sends SIGTERM, waits 5s, then SIGKILL.',
    readOnly: false,
    dangerous: true,
    inputSchema: KillBashInputSchema,
    async handler(input, ctx) {
      const registry = getShellTaskRegistry();
      const task = registry.getTask(input.taskId);
      if (!task) {
        return {
          ok: false,
          error: new NimbusError(ErrorCode.U_MISSING_CONFIG, { taskId: input.taskId }),
        };
      }

      // Security: verify task belongs to the calling workspace session.
      if (task.workspaceId !== ctx.workspaceId) {
        return {
          ok: false,
          error: new NimbusError(ErrorCode.T_PERMISSION, {
            reason: 'workspace_mismatch',
            taskId: input.taskId,
          }),
        };
      }

      if (task.done) {
        // Already finished — just return killed status for idempotency.
        registry.markKilled(input.taskId);
        return {
          ok: true,
          output: { taskId: task.id, status: 'killed' },
          display: `taskId=${task.id} already_done → marked killed`,
        };
      }

      const pid = task.pid;
      if (!pid) {
        registry.markKilled(input.taskId);
        return {
          ok: true,
          output: { taskId: task.id, status: 'killed' },
          display: `taskId=${task.id} no_pid → marked killed`,
        };
      }

      // SIGTERM first.
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process may have already exited — fall through.
      }

      // Wait up to SIGKILL_GRACE_MS for exit.
      const graceExpired = await new Promise<boolean>((resolve) => {
        let resolved = false;
        const graceTimer = setTimeout(() => {
          if (!resolved) { resolved = true; resolve(true); }
        }, SIGKILL_GRACE_MS);
        // Poll every 100ms for process to exit.
        const pollInterval = setInterval(() => {
          const t = registry.getTask(input.taskId);
          if (t?.done && !resolved) {
            resolved = true;
            clearTimeout(graceTimer);
            clearInterval(pollInterval);
            resolve(false);
          }
        }, 100);
        void graceTimer; void pollInterval; // keep references alive
      });

      if (graceExpired) {
        // Send SIGKILL.
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already dead.
        }
      }

      registry.markKilled(input.taskId);
      return {
        ok: true,
        output: { taskId: task.id, status: 'killed' },
        display: `taskId=${task.id} killed (grace=${graceExpired ? 'expired' : 'ok'})`,
      };
    },
  };
}
