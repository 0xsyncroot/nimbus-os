// keyPrompt.ts — SPEC-850: thin re-export wrapper.
// All masking logic lives in src/platform/keyPromptCore.ts.
// Existing callers that use KeyPromptOptions continue to work via promptApiKey below.
//
// Security: TTY echo disabled; chars rendered as `*`. Non-TTY input → U_BAD_COMMAND
// with hint to use --key-stdin / NIMBUS_API_KEY_STDIN=1. Ctrl-C rejects cleanly
// without printing partial value. Raw value NEVER logged.

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { promptMaskedKey } from '../platform/keyPromptCore.ts';

export { readKeyFromStdin } from '../platform/keyPromptCore.ts';

export interface KeyPromptOptions {
  provider: string;
  maskChar?: string;
  allowEmpty?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WritableStream;
  prompt?: string;
  /** If true, erases the masked-input line on exit so `*` stars don't linger. */
  clearOnExit?: boolean;
}

/**
 * promptApiKey — backward-compatible entry point for existing callers.
 * Delegates to promptMaskedKey from keyPromptCore.
 */
export async function promptApiKey(opts: KeyPromptOptions): Promise<string> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'non_interactive',
      hint: 'use --key-stdin or NIMBUS_API_KEY_STDIN=1 to pipe the key',
      provider: opts.provider,
    });
  }

  const result = await promptMaskedKey({
    prompt: opts.prompt ?? `${opts.provider} API key: `,
    input: input as NodeJS.ReadStream,
    output,
    maskChar: opts.maskChar,
    allowEmpty: opts.allowEmpty,
  });

  if (opts.clearOnExit) {
    output.write('\r\x1b[2K');
  }

  return result;
}
