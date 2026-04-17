// keyPrompt.ts — SPEC-902 T1: masked TTY readline for API key input.
//
// Security: TTY echo disabled; chars rendered as `*`. Non-TTY input → U_BAD_COMMAND
// with hint to use --key-stdin / NIMBUS_API_KEY_STDIN=1. Ctrl-C rejects cleanly
// without printing partial value. Raw value NEVER logged.

import { ErrorCode, NimbusError } from '../observability/errors.ts';

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

const DEFAULT_MASK = '*';

export async function promptApiKey(opts: KeyPromptOptions): Promise<string> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const mask = opts.maskChar ?? DEFAULT_MASK;

  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'non_interactive',
      hint: 'use --key-stdin or NIMBUS_API_KEY_STDIN=1 to pipe the key',
      provider: opts.provider,
    });
  }

  output.write(opts.prompt ?? `${opts.provider} API key: `);

  return await new Promise<string>((resolve, reject) => {
    const chars: string[] = [];
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    const cleanup = (): void => {
      input.removeListener('data', onData);
      input.pause();
      input.setRawMode(wasRaw);
      if (opts.clearOnExit) {
        // Erase the masked line so `*` stars don't leave a visible overlap.
        output.write('\r\x1b[2K');
      }
      output.write('\n');
    };

    const onData = (data: string): void => {
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (code === 0x03) {
          // Ctrl-C — never echo the partial value
          cleanup();
          reject(new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'cancelled' }));
          return;
        }
        if (code === 0x04 && chars.length === 0) {
          // Ctrl-D on empty input — treat as cancel
          cleanup();
          reject(new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'cancelled' }));
          return;
        }
        if (code === 0x0d || code === 0x0a) {
          cleanup();
          const value = chars.join('');
          if (value.length === 0 && !opts.allowEmpty) {
            reject(new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'empty_key' }));
            return;
          }
          resolve(value);
          return;
        }
        if (code === 0x7f || code === 0x08) {
          if (chars.length > 0) {
            chars.pop();
            output.write('\b \b');
          }
          continue;
        }
        if (code < 0x20) continue; // ignore other control chars
        chars.push(ch);
        output.write(mask);
      }
    };

    input.on('data', onData);
  });
}

export async function readKeyFromStdin(input?: NodeJS.ReadStream): Promise<string> {
  const src = input ?? process.stdin;
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolve, reject) => {
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
