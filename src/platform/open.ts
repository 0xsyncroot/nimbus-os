// open.ts — launch URL/file via OS handler (SPEC-151 T5)

import { detect } from './detect.ts';
import { NimbusError, ErrorCode } from '../observability/errors.ts';

const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+\-.]*:/;

export async function openPath(target: string): Promise<void> {
  if (!target || target.includes('\0')) {
    throw new NimbusError(ErrorCode.X_INJECTION, { reason: 'invalid_target' });
  }
  const caps = detect();
  const isUrl = URL_SCHEME.test(target);

  let argv: string[];
  if (caps.os === 'darwin') {
    argv = ['open', target];
  } else if (caps.os === 'win32') {
    // `start` on Windows is a cmd.exe builtin. The first quoted arg is treated as window title.
    argv = ['cmd.exe', '/c', 'start', '""', target];
  } else {
    argv = [isUrl ? 'xdg-open' : 'xdg-open', target];
  }

  const proc = Bun.spawn(argv, {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  // Do not block on completion — OS handler typically forks and returns immediately.
  proc.unref?.();
}
