// credentialManager.ts — Windows Credential Manager via `cmdkey` / PowerShell (SPEC-152 T4)

import type { SecretStore } from './index.ts';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';

export async function isCredentialManagerAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const proc = Bun.spawn(['cmdkey', '/list'], { stdout: 'ignore', stderr: 'ignore' });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

export function createCredentialManagerStore(): SecretStore {
  return {
    backend: 'credential-manager',
    async set(service, account, value) {
      assertInputs(service, account);
      const target = targetName(service, account);
      const proc = Bun.spawn(['cmdkey', `/generic:${target}`, `/user:${account}`, `/pass:${value}`], {
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new NimbusError(ErrorCode.X_CRED_ACCESS, {
          backend: 'credential-manager',
          op: 'set',
          stderr: stderr.slice(0, 200),
        });
      }
    },
    async get(service, account) {
      assertInputs(service, account);
      // `cmdkey /list` does not reveal passwords. Use PowerShell + CredentialManager API.
      const target = targetName(service, account);
      const psCmd =
        `$c = [System.Runtime.InteropServices.Marshal]::PtrToStringUni(` +
        `[System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode(` +
        `(Get-StoredCredential -Target '${target.replace(/'/g, "''")}' -ErrorAction Stop).Password)); ` +
        `Write-Output $c`;
      const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-Command', psCmd], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      if (code !== 0 || stdout.trim() === '') {
        throw new NimbusError(ErrorCode.T_NOT_FOUND, {
          backend: 'credential-manager',
          service,
          account,
        });
      }
      return stdout.replace(/\r?\n$/, '');
    },
    async delete(service, account) {
      assertInputs(service, account);
      const target = targetName(service, account);
      const proc = Bun.spawn(['cmdkey', `/delete:${target}`], { stdout: 'ignore', stderr: 'ignore' });
      const code = await proc.exited;
      if (code !== 0) {
        throw new NimbusError(ErrorCode.T_NOT_FOUND, {
          backend: 'credential-manager',
          service,
          account,
        });
      }
    },
    async list(service) {
      assertInputs(service, 'list');
      const proc = Bun.spawn(['cmdkey', '/list'], { stdout: 'pipe', stderr: 'ignore' });
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      if (code !== 0) return [];
      const prefix = `${service}:`;
      const accounts: string[] = [];
      for (const line of stdout.split('\n')) {
        const m = /Target:\s*(.+)/.exec(line);
        if (m && m[1]?.trim().startsWith(prefix)) {
          accounts.push(m[1].trim().slice(prefix.length));
        }
      }
      return accounts;
    },
  };
}

function targetName(service: string, account: string): string {
  return `${service}:${account}`;
}

function assertInputs(service: string, account: string): void {
  if (!service || !account) {
    throw new NimbusError(ErrorCode.T_VALIDATION, { reason: 'empty_service_or_account' });
  }
  if (/[\0\n\r]/.test(service) || /[\0\n\r]/.test(account)) {
    throw new NimbusError(ErrorCode.X_INJECTION, { reason: 'control_char_in_identifier' });
  }
}
