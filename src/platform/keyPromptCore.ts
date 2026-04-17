// keyPromptCore.ts — SPEC-850: non-Ink, pre-Ink key input core.
//
// Security: TTY masking with per-char '*' echo. Backspace removes last char from buffer
// AND from screen. Ctrl-C cancels cleanly without leaking partial value.
// Raw value is NEVER logged.

import { ErrorCode, NimbusError } from '../observability/errors.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptMaskedKeyOpts {
  prompt: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WritableStream;
  maskChar?: string;
  allowEmpty?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helper: enable raw mode with guaranteed cleanup
// ---------------------------------------------------------------------------

async function withRawMode<T>(
  input: NodeJS.ReadStream,
  fn: () => Promise<T>,
): Promise<T> {
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  try {
    return await fn();
  } finally {
    input.setRawMode(wasRaw);
  }
}

export { withRawMode };

// ---------------------------------------------------------------------------
// readKeyFromStdin — pipe / non-TTY path. Resolves when stream ends.
// ---------------------------------------------------------------------------

export function readKeyFromStdin(input?: NodeJS.ReadStream): Promise<string> {
  const src = input ?? (process.stdin as NodeJS.ReadStream);
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve, reject) => {
    src.on('data', (c: Buffer | string) => {
      chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    });
    src.on('end', () => {
      const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
      if (value.length === 0) {
        reject(new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'empty_stdin_key' }));
        return;
      }
      resolve(value);
    });
    src.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// promptMaskedKey — TTY path. Masks each char as '*'; handles backspace + Ctrl-C.
// Paste bursts are serialised through the 'data' event by the OS line discipline.
// If a paste contains a newline, only the text BEFORE the first newline is kept.
// ---------------------------------------------------------------------------

export async function promptMaskedKey(opts: PromptMaskedKeyOpts): Promise<string> {
  const input = opts.input ?? (process.stdin as NodeJS.ReadStream);
  const output = opts.output ?? process.stdout;
  const mask = opts.maskChar ?? '*';

  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'non_interactive',
      hint: 'use --key-stdin or NIMBUS_API_KEY_STDIN=1 to pipe the key',
    });
  }

  output.write(opts.prompt);

  return withRawMode(input, () =>
    new Promise<string>((resolve, reject) => {
      const chars: string[] = [];
      input.resume();
      input.setEncoding('utf8');

      const cleanup = (): void => {
        input.removeListener('data', onData);
        input.pause();
        output.write('\n');
      };

      const onData = (data: string): void => {
        for (const ch of data) {
          const code = ch.charCodeAt(0);

          // Ctrl-C — cancel without leaking partial value
          if (code === 0x03) {
            cleanup();
            reject(new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'cancelled' }));
            return;
          }

          // Ctrl-D on empty — treat as cancel
          if (code === 0x04 && chars.length === 0) {
            cleanup();
            reject(new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'cancelled' }));
            return;
          }

          // Enter (CR or LF) — resolve
          if (code === 0x0d || code === 0x0a) {
            cleanup();
            const value = chars.join('');
            // Clear buffer before returning
            chars.length = 0;
            if (value.length === 0 && !opts.allowEmpty) {
              reject(new NimbusError(ErrorCode.U_MISSING_CONFIG, { reason: 'empty_key' }));
              return;
            }
            resolve(value);
            return;
          }

          // Backspace / DEL — remove last char from buffer + screen
          if (code === 0x7f || code === 0x08) {
            if (chars.length > 0) {
              chars.pop();
              output.write('\b \b');
            }
            continue;
          }

          // Ignore other control chars
          if (code < 0x20) continue;

          chars.push(ch);
          output.write(mask);
        }
      };

      input.on('data', onData);
    }),
  );
}

// ---------------------------------------------------------------------------
// promptApiKey — thin wrapper: calls promptMaskedKey with a labelled prompt.
// Throws NimbusError(U_MISSING_CONFIG) on empty input.
// ---------------------------------------------------------------------------

export async function promptApiKey(label?: string): Promise<string> {
  const prompt = label ? `${label} API key: ` : 'API key: ';
  return promptMaskedKey({ prompt });
}
