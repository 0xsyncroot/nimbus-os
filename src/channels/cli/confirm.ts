// confirm.ts — SPEC-801 T2: y/n prompt with default-N + 30s timeout.

import { createInterface } from 'node:readline';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { colors, prefixes } from './colors.ts';

export interface ConfirmOptions {
  defaultNo?: boolean;
  timeoutMs?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function renderPrompt(question: string, defaultNo: boolean): string {
  const hint = defaultNo ? 'y/N' : 'Y/n';
  return `${colors.warn(prefixes.ask)} ${question} [${hint}] `;
}

function parseAnswer(raw: string, defaultNo: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return !defaultNo;
  if (v === 'y' || v === 'yes') return true;
  if (v === 'n' || v === 'no') return false;
  return !defaultNo ? true : false === !defaultNo ? false : false;
}

function strictAnswer(raw: string, defaultNo: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return !defaultNo;
  if (v === 'y' || v === 'yes') return true;
  return false;
}

export async function confirm(question: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const defaultNo = opts.defaultNo ?? true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  const rl = createInterface({ input, output, terminal: false });
  const promptText = renderPrompt(question, defaultNo);

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rl.close();
      output.write(`\n${colors.dim('(timeout — default: No)')}\n`);
      resolve(false);
    }, timeoutMs);

    const onSigint = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      reject(new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'cancelled' }));
    };
    rl.once('SIGINT', onSigint);

    rl.question(promptText, (answer: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(strictAnswer(answer, defaultNo));
    });
  });
}

// Exported for tests.
export const __testing = { parseAnswer, strictAnswer, renderPrompt };
