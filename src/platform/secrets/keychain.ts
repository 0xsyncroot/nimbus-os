// keychain.ts — macOS Keychain via `security` CLI (SPEC-152 T2)

import type { SecretStore } from './index.ts';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';

export async function isKeychainAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const proc = Bun.spawn(['security', '-h'], { stdout: 'ignore', stderr: 'ignore' });
    const code = await proc.exited;
    return code === 0 || code === 1; // `-h` returns 1 on some versions but means "present"
  } catch {
    return false;
  }
}

export function createKeychainStore(): SecretStore {
  return {
    backend: 'keychain',
    async set(service, account, value) {
      assertInputs(service, account);
      const args = [
        'add-generic-password',
        '-a',
        account,
        '-s',
        service,
        '-w',
        value,
        '-U', // update if exists
      ];
      const proc = Bun.spawn(['security', ...args], { stdout: 'ignore', stderr: 'pipe' });
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new NimbusError(ErrorCode.X_CRED_ACCESS, {
          backend: 'keychain',
          op: 'set',
          stderr: stderr.slice(0, 200),
        });
      }
    },
    async get(service, account) {
      assertInputs(service, account);
      const proc = Bun.spawn(
        ['security', 'find-generic-password', '-a', account, '-s', service, '-w'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      if (code !== 0) {
        throw new NimbusError(ErrorCode.T_NOT_FOUND, { backend: 'keychain', service, account });
      }
      return stdout.replace(/\n$/, '');
    },
    async delete(service, account) {
      assertInputs(service, account);
      const proc = Bun.spawn(
        ['security', 'delete-generic-password', '-a', account, '-s', service],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      const code = await proc.exited;
      if (code !== 0) {
        throw new NimbusError(ErrorCode.T_NOT_FOUND, { backend: 'keychain', service, account });
      }
    },
    async list(service) {
      assertInputs(service, 'list');
      // `security dump-keychain` is noisy + requires user auth. `security find-generic-password -s <svc>`
      // returns only one entry. For v0.1 we do not expose full listing on macOS — caller stores the
      // account index elsewhere. Return empty list to preserve interface contract.
      return [];
    },
  };
}

function assertInputs(service: string, account: string): void {
  if (!service || !account) {
    throw new NimbusError(ErrorCode.T_VALIDATION, { reason: 'empty_service_or_account' });
  }
  if (/[\0\n\r]/.test(service) || /[\0\n\r]/.test(account)) {
    throw new NimbusError(ErrorCode.X_INJECTION, { reason: 'control_char_in_identifier' });
  }
}
