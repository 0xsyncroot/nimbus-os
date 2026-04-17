// recoveryPrompt.ts — Boot vault recovery UX v2 (SPEC-505)
// Renders a calm Vietnamese prompt. Fix path delegates to SPEC-904 interactive key manager.
// HARD RULES (from SPEC-505 + §10 user data sanctity):
//   - Never write vault bytes directly (delegated entirely to SPEC-904 module)
//   - Backup before any mutation: secrets.enc → secrets.enc.bak-{ts}-corrupt
//   - Backup rotation: keep last 5 corrupt backups (prune older by mtime)
//   - No passphrase logged

import { chmod, copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { nimbusHome } from '../platform/paths.ts';
import type { VaultStatusReason } from '../platform/secrets/diagnose.ts';

const VAULT_FILENAME = 'secrets.enc';
const MAX_CORRUPT_BACKUPS = 5;

export interface RecoveryInput {
  readonly reason: VaultStatusReason;
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Backup helpers
// ---------------------------------------------------------------------------

function corruptBackupPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(nimbusHome(), `secrets.enc.bak-${ts}-corrupt`);
}

async function backupCorruptVault(): Promise<void> {
  const src = join(nimbusHome(), VAULT_FILENAME);
  const dst = corruptBackupPath();
  try {
    await mkdir(nimbusHome(), { recursive: true });
    await copyFile(src, dst);
    // HARD RULE §6 (post-v0.3.6): vault-derived files MUST be 0o600 on POSIX.
    // copyFile honors umask, which can leak 0o644 when user's umask is 0o022.
    if (process.platform !== 'win32') await chmod(dst, 0o600);
  } catch {
    // vault may not exist — silently skip
  }
  await pruneCorruptBackups();
}

async function pruneCorruptBackups(): Promise<void> {
  const dir = nimbusHome();
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.match(/^secrets\.enc\.bak-.*-corrupt$/));
  } catch {
    return;
  }

  const withMtime: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of entries) {
    try {
      const s = await stat(join(dir, name));
      withMtime.push({ name, mtimeMs: s.mtimeMs });
    } catch {
      // vanished
    }
  }

  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const toDelete = withMtime.slice(MAX_CORRUPT_BACKUPS);
  for (const entry of toDelete) {
    try {
      await unlink(join(dir, entry.name));
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

const PROMPT_TEXT = [
  '',
  'Em không mở được API key đã lưu (vault bị khóa).',
  '',
  '  [Enter]  Nhập lại key ngay (khuyến nghị)',
  '  [s]      Bỏ qua, mở nimbus không có key',
  '  [q]      Thoát',
  '',
  'Chọn: ',
].join('\n');

type PromptChoice = 'fix' | 'skip' | 'quit' | 'invalid';

function parseChoice(raw: string): PromptChoice {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'enter') return 'fix';
  if (trimmed === 's' || trimmed === 'skip') return 'skip';
  if (trimmed === 'q' || trimmed === 'quit') return 'quit';
  return 'invalid';
}

async function promptRecoveryChoice(): Promise<PromptChoice> {
  // Accumulate all stdin data into a line buffer, handle multiple lines (re-prompt on invalid).
  return new Promise<PromptChoice>((resolve) => {
    let buf = '';
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdout.write(PROMPT_TEXT);

    const cleanup = (): void => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.pause();
    };

    const onEnd = (): void => {
      cleanup();
      process.stdout.write('\n');
      resolve('quit'); // EOF → quit
    };

    const onData = (chunk: string): void => {
      if (chunk === '\x03') {
        cleanup();
        process.stdout.write('\n');
        resolve('quit');
        return;
      }
      buf += chunk;
      // Process all complete lines in the buffer
      let nlIdx: number;
      while ((nlIdx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nlIdx);
        buf = buf.slice(nlIdx + 1);
        const choice = parseChoice(line);
        if (choice !== 'invalid') {
          cleanup();
          process.stdout.write('\n');
          resolve(choice);
          return;
        }
        // Invalid → re-show prompt and read next line
        process.stdout.write(PROMPT_TEXT);
      }
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}

// ---------------------------------------------------------------------------
// Fix flow — delegates to SPEC-904 runInteractiveKeyManager
// ---------------------------------------------------------------------------

async function runFixFlow(): Promise<boolean> {
  await backupCorruptVault();

  try {
    const { runInteractiveKeyManager } = await import('../key/interactive.ts');
    const { getActiveWorkspace } = await import('../core/workspace.ts');
    const ws = await getActiveWorkspace().catch(() => null);
    const workspaceId = ws?.id ?? 'personal';

    const exitCode = await runInteractiveKeyManager({
      workspaceId,
      input: process.stdin,
      output: process.stdout,
      isTTY: Boolean(process.stdin.isTTY),
    });

    return exitCode === 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  Lỗi khi khôi phục key: ${msg}\n  Chạy \`nimbus key\` để thử lại.\n\n`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * runRecoveryPrompt — called at startup when diagnoseVault returns !ok.
 * Returns true if handled (proceed to REPL), false if caller should exit 2.
 */
export async function runRecoveryPrompt(
  input: RecoveryInput,
  opts: { readonly tty: boolean },
): Promise<boolean> {
  const { reason } = input;

  // missing_file is benign — first run before init wizard, always allow boot.
  if (reason === 'missing_file') {
    return true;
  }

  // schema_newer is unresolvable — user must upgrade nimbus binary.
  if (reason === 'schema_newer') {
    process.stdout.write(
      '\n  Vault được tạo bởi phiên bản nimbus mới hơn. Hãy nâng cấp nimbus để tiếp tục.\n\n',
    );
    return false;
  }

  // Non-TTY: cannot show interactive prompt. Still back up the broken vault
  // so a future TTY session / manual recovery can inspect the original envelope.
  if (!opts.tty) {
    await backupCorruptVault();
    process.stdout.write(
      '\n  Em không mở được API key đã lưu (vault bị khóa).\n' +
      '  Workspace, SOUL, MEMORY vẫn nguyên.\n' +
      '  Non-interactive session — chạy `nimbus key` trên terminal để khôi phục.\n\n',
    );
    return false;
  }

  const choice = await promptRecoveryChoice();

  if (choice === 'fix') {
    return await runFixFlow();
  }

  if (choice === 'skip') {
    process.stdout.write(
      '\nĐã bỏ qua. Chạy `nimbus check` khi em sẵn sàng để chẩn đoán.\n\n',
    );
    return true; // boot continues, no key — provider calls will fail gracefully
  }

  // quit
  process.stdout.write(
    '\nĐã thoát. Không thay đổi gì.\n\n',
  );
  return false;
}
