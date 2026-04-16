// sandbox.ts — SPEC-310 T5: Bun Worker sandbox runner.
// Mandatory for ALL tiers including TRUSTED.
// Derives Worker permission flags from SkillManifest.
// Wraps skill tool output in <tool_output trusted="false"> per META-009.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import type { SkillManifest } from './manifest.ts';

export interface SandboxInput {
  skillName: string;
  skillVersion: string;
  entryCode: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

export interface SandboxResult {
  output: string;  // wrapped in <tool_output trusted="false">
  exitCode: number;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * buildWorkerPermFlags — derive Bun Worker permission flags from manifest.
 * Baseline: --deny-all. Add back only what manifest declares.
 *
 * Note: Bun compile --deny-all is the baseline; individual allows are additive.
 * For LOCAL tier: network restrictions from manifest still apply (no free egress).
 */
export function buildWorkerPermFlags(manifest: SkillManifest): string[] {
  const flags: string[] = [];

  // Network
  const hosts = manifest.permissions.network?.hosts ?? [];
  if (hosts.length > 0) {
    flags.push(`--allow-net=${hosts.join(',')}`);
  }
  // No network perm → deny-all covers it

  // File read
  const fsReadPaths = manifest.permissions.fsRead ?? [];
  if (fsReadPaths.length > 0) {
    flags.push(`--allow-read=${fsReadPaths.join(',')}`);
  }

  // File write
  const fsWritePaths = manifest.permissions.fsWrite ?? [];
  if (fsWritePaths.length > 0) {
    flags.push(`--allow-write=${fsWritePaths.join(',')}`);
  }

  // Env vars
  const envVars = manifest.permissions.env ?? [];
  if (envVars.length > 0) {
    flags.push(`--allow-env=${envVars.join(',')}`);
  }

  // Bash (subprocess) only if explicitly declared
  const bashAllowed = manifest.permissions.bash?.allow ?? [];
  if (bashAllowed.length > 0) {
    flags.push('--allow-run');
  }

  return flags;
}

/**
 * wrapToolOutput — wraps raw skill output in untrusted boundary per META-009.
 * Prevents prompt injection from skill output into canonical IR.
 */
export function wrapToolOutput(raw: string): string {
  return `<tool_output trusted="false">\n${raw}\n</tool_output>`;
}

/**
 * workerScript — inline worker script that executes skill entry code.
 * The skill code runs in a restricted Worker context.
 */
function buildWorkerScript(entryCode: string, args: Record<string, unknown>): string {
  // The worker receives args via postMessage and posts result back.
  return `
// nimbus skill sandbox worker
const args = ${JSON.stringify(args)};
try {
  const fn = new Function('args', ${JSON.stringify(entryCode)});
  const result = fn(args);
  if (result && typeof result.then === 'function') {
    result.then((v) => {
      postMessage({ ok: true, output: String(v ?? '') });
    }).catch((err) => {
      postMessage({ ok: false, error: String(err?.message ?? err) });
    });
  } else {
    postMessage({ ok: true, output: String(result ?? '') });
  }
} catch (err) {
  postMessage({ ok: false, error: String(err?.message ?? err) });
}
`;
}

/**
 * runInSandbox — execute skill code in a Bun Worker with manifest-derived permissions.
 * Returns SandboxResult with output wrapped per META-009.
 *
 * NOTE: Bun Worker permission flags (--allow-net etc.) are passed via
 * workerData in v0.3 as a best-effort mechanism. Bun's Worker API does not
 * yet support per-Worker permission flags at the JS API level (that's a
 * binary compile flag). We implement the security contract via:
 * 1. Code isolation in Worker (separate VM context)
 * 2. Output sanitization (wrapToolOutput)
 * 3. Timeout enforcement
 * The permission flags are recorded in audit log for v0.3.1 enforcement.
 */
export async function runInSandbox(
  manifest: SkillManifest,
  input: SandboxInput,
): Promise<SandboxResult> {
  const start = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const permFlags = buildWorkerPermFlags(manifest);

  logger.info(
    { skill: input.skillName, version: input.skillVersion, permFlags },
    'sandbox_start',
  );

  // Build inline worker blob URL
  const workerScript = buildWorkerScript(input.entryCode, input.args);
  const blob = new Blob([workerScript], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);

  return new Promise<SandboxResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(
        new NimbusError(ErrorCode.T_TIMEOUT, {
          reason: 'sandbox_timeout',
          skill: input.skillName,
          timeoutMs,
        }),
      );
    }, timeoutMs);

    const worker = new Worker(workerUrl, {
      type: 'module',
      // Pass permission metadata for audit (not enforced at Worker API level in v0.3)
      // @ts-expect-error — workerData is Bun-specific
      workerData: { permFlags, skillName: input.skillName },
    });

    worker.onmessage = (event: MessageEvent<{ ok: boolean; output?: string; error?: string }>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(workerUrl);

      const durationMs = Date.now() - start;
      const { ok, output, error } = event.data;

      if (!ok) {
        logger.warn({ skill: input.skillName, error }, 'sandbox_skill_error');
        resolve({
          output: wrapToolOutput(`error: ${error ?? 'unknown'}`),
          exitCode: 1,
          durationMs,
        });
        return;
      }

      logger.info({ skill: input.skillName, durationMs }, 'sandbox_complete');
      resolve({
        output: wrapToolOutput(output ?? ''),
        exitCode: 0,
        durationMs,
      });
    };

    worker.onerror = (event: ErrorEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(workerUrl);

      logger.error({ skill: input.skillName, error: event.message }, 'sandbox_worker_error');
      reject(
        new NimbusError(ErrorCode.T_CRASH, {
          reason: 'sandbox_worker_crash',
          skill: input.skillName,
          detail: event.message,
        }),
      );
    };
  });
}

/**
 * sandboxSideEffectTier — map manifest sideEffects to sandbox strictness level.
 * Logged for audit trail.
 */
export function sandboxSideEffectTier(
  sideEffects: SkillManifest['permissions']['sideEffects'],
): 'read-only' | 'write-allowed' | 'exec-allowed' | 'pure' {
  switch (sideEffects) {
    case 'pure': return 'pure';
    case 'read': return 'read-only';
    case 'write': return 'write-allowed';
    case 'exec': return 'exec-allowed';
  }
}
