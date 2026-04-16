// Bash.ts — SPEC-303 T5 + SPEC-308 T2/T3: bash tool with tier-1 security, timeout, background mode.

import { z } from 'zod';
import { ErrorCode, NimbusError, wrapError } from '../../observability/errors.ts';
import { appendAudit, sha256Hex } from '../../observability/auditLog.ts';
import { detect } from '../../platform/detect.ts';
import { checkShellCommand, type Shell } from '../../permissions/shellSecurityDispatcher.ts';
import { redactSecrets } from './fsHelpers.ts';
import { getShellTaskRegistry } from '../../core/shellTaskRegistry.ts';
import type { Tool } from '../types.ts';

/** Auto-background threshold: if command still running after this, promote to bg. */
export const AUTO_BG_THRESHOLD_MS = 30_000;

/** Tail line count returned when a command is auto-backgrounded or run_in_background. */
const BG_TAIL_LINES = 50;

export const BashInputSchema = z.object({
  command: z.string().min(1).max(16_000),
  run_in_background: z.boolean().optional(),
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

export interface BashBackgroundOutput {
  taskId: string;
  status: 'running';
  stdout: string;
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

/** Split a raw output chunk into UTF-8-safe lines, flushing incomplete line back. */
function splitLines(partial: string, chunk: string): { lines: string[]; remainder: string } {
  const combined = partial + chunk;
  const parts = combined.split('\n');
  const remainder = parts.pop() ?? '';
  return { lines: parts, remainder };
}

export function createBashTool(deps: BashDeps = {}): Tool<BashInput, BashOutput | BashBackgroundOutput> {
  const shell: Shell = deps.shell ?? detectShellKind();
  return {
    name: 'Bash',
    description:
      'Execute a shell command with tier-1 security check. Output truncated to 10KB/stream. Timeout default 120s. Set run_in_background:true for long-running commands.',
    readOnly: false,
    dangerous: true,
    inputSchema: BashInputSchema,
    async handler(input, ctx) {
      const started = Date.now();
      // 1. Pre-spawn security check (always, even for background mode).
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

      // Background mode: spawn detached, register task, return immediately.
      if (input.run_in_background === true) {
        return spawnBackground(input.command, executable, flag, cwd, ctx.workspaceId, ctx.sessionId);
      }

      // Foreground mode with auto-background heuristic at 30s.
      let timedOut = false;
      let autoBged = false;
      const ctrl = new AbortController();
      const onCancel = (): void => ctrl.abort(new Error('tool_abort'));
      ctx.onAbort(onCancel);
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort(new Error('timeout'));
      }, input.timeoutMs);

      // Auto-background timer fires at 30s if process still running.
      let autoBgTimer: ReturnType<typeof setTimeout> | null = null;
      let autoBgResolve: ((v: void) => void) | null = null;
      const autoBgPromise = new Promise<void>((resolve) => { autoBgResolve = resolve; });
      autoBgTimer = setTimeout(() => { autoBgResolve?.(); }, AUTO_BG_THRESHOLD_MS);

      try {
        const proc = Bun.spawn([executable, flag, input.command], {
          cwd,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          signal: ctrl.signal,
        });

        // Race: process finishes or auto-bg timer fires.
        const exitRace = proc.exited;
        const autoBgRace = autoBgPromise.then(() => 'AUTO_BG' as const);

        const raceResult = await Promise.race([exitRace, autoBgRace]);

        if (raceResult === 'AUTO_BG') {
          // Process is still running — promote to background.
          clearTimeout(timer);
          clearTimeout(autoBgTimer);
          autoBged = true;

          // Register as background task using pid.
          const registry = getShellTaskRegistry();
          const task = registry.createTask(input.command, ctx.workspaceId, proc.pid ?? 0);

          // Drain current stdout/stderr for tail, then keep streaming.
          const drainAndStream = async (
            stream: ReadableStream<Uint8Array> | null,
            appendFn: (id: string, line: string) => void,
          ): Promise<string[]> => {
            if (!stream) return [];
            const reader = stream.getReader();
            const collectedLines: string[] = [];
            let remainder = '';
            // Non-blocking drain: read available data with a short timeout per chunk.
            while (true) {
              const readResult = await Promise.race([
                reader.read(),
                new Promise<{ done: boolean; value?: undefined }>((r) =>
                  setTimeout(() => r({ done: false, value: undefined }), 0),
                ),
              ]);
              if (readResult.value === undefined) break; // no more buffered data
              if (readResult.done) break;
              const chunk = new TextDecoder('utf-8').decode(readResult.value);
              const { lines, remainder: rem } = splitLines(remainder, chunk);
              remainder = rem;
              for (const line of lines) {
                collectedLines.push(line);
                appendFn(task.id, line);
              }
            }
            // Continue streaming in background.
            void (async () => {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                const chunk = new TextDecoder('utf-8').decode(value);
                const { lines, remainder: rem2 } = splitLines(remainder, chunk);
                remainder = rem2;
                for (const line of lines) appendFn(task.id, line);
              }
              if (remainder) appendFn(task.id, remainder);
            })();
            return collectedLines;
          };

          const [stdoutLines, stderrLines] = await Promise.all([
            drainAndStream(proc.stdout, (id, l) => registry.appendStdout(id, l)),
            drainAndStream(proc.stderr, (id, l) => registry.appendStderr(id, l)),
          ]);

          // Handle exit in background.
          void proc.exited.then((code) => {
            registry.markDone(task.id, code ?? 0);
          });

          const tail = [...stdoutLines, ...stderrLines].slice(-BG_TAIL_LINES).join('\n');
          return {
            ok: true,
            output: { taskId: task.id, status: 'running', stdout: tail },
            display: `[auto-backgrounded after 30s] taskId=${task.id}\n${tail}`,
          };
        }

        // Process exited normally (raceResult is exit code number).
        clearTimeout(timer);
        clearTimeout(autoBgTimer);

        const [stdoutText, stderrText] = await Promise.all([
          readCapped(proc.stdout, MAX_OUTPUT),
          readCapped(proc.stderr, MAX_OUTPUT),
        ]);
        const exitCode = raceResult as number;

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
        clearTimeout(timer);
        clearTimeout(autoBgTimer!);
        if (timedOut) {
          return {
            ok: false,
            error: new NimbusError(ErrorCode.T_TIMEOUT, { timeoutMs: input.timeoutMs }),
          };
        }
        if (autoBged) {
          return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
        }
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      } finally {
        clearTimeout(timer);
        if (autoBgTimer) clearTimeout(autoBgTimer);
      }
    },
  };
}

/** Spawn a process immediately in background and return taskId. */
async function spawnBackground(
  command: string,
  executable: string,
  flag: string,
  cwd: string,
  workspaceId: string,
  sessionId: string,
): Promise<{ ok: true; output: BashBackgroundOutput; display?: string } | { ok: false; error: NimbusError }> {
  try {
    const proc = Bun.spawn([executable, flag, command], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const registry = getShellTaskRegistry();
    const task = registry.createTask(command, workspaceId, proc.pid ?? 0);

    // Stream stdout/stderr lines to registry + event bus in background.
    void streamToRegistry(proc.stdout, task.id, (id, l) => registry.appendStdout(id, l));
    void streamToRegistry(proc.stderr, task.id, (id, l) => registry.appendStderr(id, l));

    // Handle exit.
    void proc.exited.then((code) => {
      registry.markDone(task.id, code ?? 0);
    });

    appendAudit({
      schemaVersion: 1,
      ts: Date.now(),
      sessionId,
      kind: 'tool_call',
      toolName: 'Bash',
      inputDigest: sha256Hex(command),
      outcome: 'ok',
      decisionReason: `background taskId=${task.id}`,
    }).catch(() => undefined);

    return {
      ok: true,
      output: { taskId: task.id, status: 'running', stdout: '' },
      display: `[background] taskId=${task.id} pid=${proc.pid}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
  }
}

async function streamToRegistry(
  stream: ReadableStream<Uint8Array> | null,
  taskId: string,
  appendFn: (id: string, line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let remainder = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (remainder) appendFn(taskId, remainder);
      break;
    }
    if (!value) continue;
    const chunk = decoder.decode(value, { stream: true });
    const { lines, remainder: rem } = splitLines(remainder, chunk);
    remainder = rem;
    for (const line of lines) appendFn(taskId, line);
  }
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
