// secretService.ts — Linux libsecret via `secret-tool` CLI (SPEC-152 T3)

import type { SecretStore } from './index.ts';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';

export async function isSecretServiceAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  if (!process.env['DBUS_SESSION_BUS_ADDRESS']) return false;
  try {
    const proc = Bun.spawn(['secret-tool', '--version'], { stdout: 'ignore', stderr: 'ignore' });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

export function createSecretServiceStore(): SecretStore {
  return {
    backend: 'secret-service',
    async set(service, account, value) {
      assertInputs(service, account);
      const proc = Bun.spawn(
        ['secret-tool', 'store', '--label', `${service}:${account}`, 'service', service, 'account', account],
        { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
      );
      proc.stdin.write(value);
      proc.stdin.end();
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new NimbusError(ErrorCode.X_CRED_ACCESS, {
          backend: 'secret-service',
          op: 'set',
          stderr: stderr.slice(0, 200),
        });
      }
    },
    async get(service, account) {
      assertInputs(service, account);
      const proc = Bun.spawn(
        ['secret-tool', 'lookup', 'service', service, 'account', account],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      if (code !== 0 || stdout === '') {
        throw new NimbusError(ErrorCode.T_NOT_FOUND, { backend: 'secret-service', service, account });
      }
      return stdout.replace(/\n$/, '');
    },
    async delete(service, account) {
      assertInputs(service, account);
      const proc = Bun.spawn(
        ['secret-tool', 'clear', 'service', service, 'account', account],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      const code = await proc.exited;
      if (code !== 0) {
        throw new NimbusError(ErrorCode.T_NOT_FOUND, { backend: 'secret-service', service, account });
      }
    },
    async list(service) {
      assertInputs(service, 'list');
      const proc = Bun.spawn(['secret-tool', 'search', '--all', 'service', service], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      if (code !== 0) return [];
      const accounts: string[] = [];
      for (const line of stdout.split('\n')) {
        const m = /^attribute\.account\s*=\s*(.+)$/.exec(line);
        if (m && m[1]) accounts.push(m[1]);
      }
      return accounts;
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
