// Bash.ts — SPEC-303 T5: bash tool with tier-1 security check + audit + timeout + abort.

import { z } from 'zod';
import { ErrorCode, NimbusError, wrapError } from '../../observability/errors.ts';
import { appendAudit, sha256Hex } from '../../observability/auditLog.ts';
import { detect } from '../../platform/detect.ts';
import { checkShellCommand, type Shell } from '../../permissions/shellSecurityDispatcher.ts';
import { redactSecrets } from './fsHelpers.ts';
import type { Tool } from '../types.ts';

export const BashInputSchema = z.object({
  command: z.string().min(1).max(16_000),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  cwd: z.string().optional(),
  description: z.string().max(120).optional(),
}).strict();
export type BashInput = z.infer<typeof BashInputSchema>;

export interface BashOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_OUTPUT = 10 * 1024;

export interface BashDeps {
  shell?: Shell;
}

function detectShellKind(): Shell {
  const caps = detect();
  const s = caps.defaultShell;
  if (s === 'bash' || s === 'zsh' || s === 'fish') return 'bash';
  if (s === 'pwsh') return 'pwsh';
  if (s === 'cmd') return 'cmd';
  return caps.os === 'win32' ? 'pwsh' : 'bash';
}

export function createBashTool(deps: BashDeps = {}): Tool<BashInput, BashOutput> {
  const shell: Shell = deps.shell ?? detectShellKind();
  return {
    name: 'Bash',
    description: 'Execute a shell command with tier-1 security check. Output truncated to 10KB/stream. Timeout default 120s.',
    readOnly: false,
    dangerous: true,
    inputSchema: BashInputSchema,
    async handler(input, ctx) {
      const started = Date.now();
      // 1. Pre-spawn security check.
      const check = checkShellCommand(shell, input.command);
      if (!check.ok) {
        const digest = sha256Hex(input.command);
        appendAudit({
          schemaVersion: 1,
          ts: Date.now(),
          sessionId: ctx.sessionId,
          kind: 'tool_call',
          toolName: 'Bash',
          inputDigest: digest,
          outcome: 'denied',
          decisionReason: `${check.rule ?? 'unknown'}:${check.reason ?? ''}`,
        }).catch(() => undefined);
        return {
          ok: false,
          error: new NimbusError(ErrorCode.X_BASH_BLOCKED, {
            rule: check.rule,
            reason: check.reason,
            threat: check.threat,
          }),
        };
      }

      if (shell === 'cmd' || shell === 'unknown') {
        return {
          ok: false,
          error: new NimbusError(ErrorCode.X_BASH_BLOCKED, {
            reason: 'shell_unsupported',
            shell,
          }),
        };
      }

      // 2. Spawn.
      const cwd = input.cwd ?? ctx.cwd;
      const executable = shell === 'pwsh' ? 'pwsh' : 'bash';
      const flag = shell === 'pwsh' ? '-Command' : '-c';
      let timedOut = false;
      const ctrl = new AbortController();
      const onCancel = (): void => ctrl.abort(new Error('tool_abort'));
      ctx.onAbort(onCancel);
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort(new Error('timeout'));
      }, input.timeoutMs);
      try {
        const proc = Bun.spawn([executable, flag, input.command], {
          cwd,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          signal: ctrl.signal,
        });
        const [stdoutText, stderrText] = await Promise.all([
          readCapped(proc.stdout, MAX_OUTPUT),
          readCapped(proc.stderr, MAX_OUTPUT),
        ]);
        const exitCode = await proc.exited;
        if (timedOut) {
          appendAudit({
            schemaVersion: 1,
            ts: Date.now(),
            sessionId: ctx.sessionId,
            kind: 'tool_call',
            toolName: 'Bash',
            inputDigest: sha256Hex(input.command),
            outcome: 'error',
            decisionReason: 'timeout',
          }).catch(() => undefined);
          return {
            ok: false,
            error: new NimbusError(ErrorCode.T_TIMEOUT, {
              timeoutMs: input.timeoutMs,
            }),
          };
        }
        const stdoutRed = redactSecrets(stdoutText);
        const stderrRed = redactSecrets(stderrText);
        appendAudit({
          schemaVersion: 1,
          ts: Date.now(),
          sessionId: ctx.sessionId,
          kind: 'tool_call',
          toolName: 'Bash',
          inputDigest: sha256Hex(input.command),
          outcome: exitCode === 0 ? 'ok' : 'error',
          decisionReason: `exit=${exitCode}`,
        }).catch(() => undefined);
        return {
          ok: true,
          output: {
            exitCode,
            stdout: stdoutRed,
            stderr: stderrRed,
            timedOut: false,
            durationMs: Date.now() - started,
          },
          display: formatDisplay(exitCode, stdoutRed, stderrRed),
        };
      } catch (err) {
        if (timedOut) {
          return {
            ok: false,
            error: new NimbusError(ErrorCode.T_TIMEOUT, { timeoutMs: input.timeoutMs }),
          };
        }
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = max - total;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      total += remaining;
      truncated = true;
    } else {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const text = new TextDecoder('utf-8').decode(buf);
  return truncated ? text + '\n[...truncated at 10KB...]' : text;
}

function formatDisplay(code: number, stdout: string, stderr: string): string {
  const parts: string[] = [];
  parts.push(`exit ${code}`);
  if (stdout) parts.push('--- stdout ---\n' + stdout);
  if (stderr) parts.push('--- stderr ---\n' + stderr);
  return parts.join('\n');
}
