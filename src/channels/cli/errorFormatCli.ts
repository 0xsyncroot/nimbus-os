// errorFormatCli.ts — SPEC-826 T2: map ErrorCode → friendly CLI sentence per locale.
// NEVER include toolUseId, raw ms, stack traces, or raw context JSON in output.

import type { Locale } from '../../core/toolLabels.ts';

type ErrInput = { code: string; context: Record<string, unknown> };

function safeStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

const MAP_VN: Record<string, (ctx: Record<string, unknown>) => string> = {
  T_PERMISSION: (ctx) => {
    const sub = safeStr(ctx['reason']);
    if (sub === 'needs_confirm') {
      const action = safeStr(ctx['action'], 'hành động này');
      return `Em dừng lại — cần anh cho phép em ${action}.`;
    }
    if (sub === 'user_denied') {
      return 'Anh đã từ chối — em dừng ở đây.';
    }
    const action = safeStr(ctx['action'], 'hành động này');
    return `Anh đã chặn em ${action}.`;
  },
  T_VALIDATION:   (_) => 'Em gọi công cụ sai cú pháp, đang thử lại.',
  T_TIMEOUT:      (_) => 'Quá lâu, em tạm dừng. Thử lại?',
  T_NOT_FOUND:    (c) => `Không tìm thấy ${safeStr(c['target'], 'mục tiêu')}.`,
  T_CRASH:        (_) => 'Lỗi khi chạy tool.',
  P_NETWORK:      (_) => 'Mạng chập chờn — em thử lại tự động\u2026',
  P_AUTH:         (_) => 'Em chưa vào được provider — kiểm tra API key.',
  X_BASH_BLOCKED: (c) => `Em không thể chạy lệnh này vì bảo mật: ${safeStr(c['reason'], 'lý do bảo mật')}.`,
  X_PATH_BLOCKED: (c) => `Em không được phép truy cập ${safeStr(c['path'], 'đường dẫn này')}.`,
  X_CRED_ACCESS:  (_) => 'Em không đụng vào credential — file này nằm trong deny-list.',
};

const MAP_EN: Record<string, (ctx: Record<string, unknown>) => string> = {
  T_PERMISSION: (ctx) => {
    const sub = safeStr(ctx['reason']);
    if (sub === 'needs_confirm') {
      const action = safeStr(ctx['action'], 'this action');
      return `Paused — I need your permission to ${action}.`;
    }
    if (sub === 'user_denied') {
      return 'Declined — I will stop here.';
    }
    const action = safeStr(ctx['action'], 'this action');
    return `You denied ${action}.`;
  },
  T_VALIDATION:   (_) => 'Invalid tool input — retrying.',
  T_TIMEOUT:      (_) => 'Timed out — try again?',
  T_NOT_FOUND:    (c) => `${safeStr(c['target'], 'Target')} not found.`,
  T_CRASH:        (_) => 'Tool crashed.',
  P_NETWORK:      (_) => 'Network hiccup — retrying\u2026',
  P_AUTH:         (_) => "Can't reach provider — check your API key.",
  X_BASH_BLOCKED: (c) => `Command blocked for safety: ${safeStr(c['reason'], 'security policy')}.`,
  X_PATH_BLOCKED: (c) => `Path ${safeStr(c['path'], '(unknown)')} is off-limits.`,
  X_CRED_ACCESS:  (_) => 'Credential file is off-limits — I will not touch it.',
};

/**
 * Format a tool-scoped error into a friendly sentence for the CLI.
 * Output MUST NOT contain raw error codes, toolUseId, ms, or stack traces.
 */
export function formatToolError(err: ErrInput, locale: Locale): string {
  const map = locale === 'vi' ? MAP_VN : MAP_EN;
  // Strip subcode suffix like T_PERMISSION:needs_confirm — look up base code
  const baseCode = err.code.split(':')[0] ?? err.code;
  const fn = map[baseCode];
  if (fn) return fn(err.context);
  // v0.3.4 (Bug B/C follow-up): the fallback is shown to non-dev users too, so
  // drop the `--verbose` dev-hint. Include the code in a soft way for support
  // triage. Devs can still read full context in audit log.
  if (locale === 'vi') {
    return err.code.length > 0
      ? `Công cụ gặp lỗi (${err.code}) — em không hoàn thành bước này.`
      : 'Công cụ gặp lỗi — em không hoàn thành bước này.';
  }
  return err.code.length > 0
    ? `Tool failed (${err.code}) — step did not complete.`
    : 'Tool failed — step did not complete.';
}

/**
 * Format a REPL-level startup/boot error into a friendly message + recovery
 * hint. Used by runSingleTurn when provider init fails with U_MISSING_CONFIG,
 * X_CRED_ACCESS, or similar vault/key issues. The hint field comes from the
 * thrower; we intentionally surface it because it already tells the user the
 * exact command to run (`nimbus key set openai`, `nimbus vault reset`, ...).
 * Never echoes the full raw JSON context.
 */
export function formatBootError(err: ErrInput, locale: Locale): { line: string; hint: string | null } {
  const ctx = err.context ?? {};
  const reason = safeStr(ctx['reason']);
  const hint = safeStr(ctx['hint']) || null;
  const provider = safeStr(ctx['provider']);
  const baseCode = err.code.split(':')[0] ?? err.code;

  if (locale === 'vi') {
    if (baseCode === 'U_MISSING_CONFIG') {
      if (reason === 'provider_key_missing' || reason === 'key_ref_unresolved') {
        const who = provider ? `cho ${provider}` : '';
        return {
          line: `Chưa có API key ${who}đê em chat được.`.replace(/  +/g, ' ').trim(),
          hint,
        };
      }
      if (reason === 'no_active_workspace') {
        return { line: 'Chưa có workspace — anh chạy `nimbus init` trước nhé.', hint };
      }
      if (reason === 'missing_passphrase') {
        return {
          line: 'Vault đang khoá — chưa có passphrase để mở key đã lưu.',
          hint: hint ?? 'set NIMBUS_VAULT_PASSPHRASE hoặc chạy `nimbus vault reset`',
        };
      }
      return { line: 'Thiếu cấu hình để khởi động.', hint };
    }
    if (baseCode === 'X_CRED_ACCESS') {
      if (reason === 'vault_locked' || reason === 'tag_verify_fail') {
        return {
          line: 'Key đã lưu trước đây không mở được bằng passphrase hiện tại (có thể sau khi upgrade binary).',
          hint: hint ?? 'khôi phục NIMBUS_VAULT_PASSPHRASE cũ, hoặc chạy `nimbus vault reset` để nhập lại key (vault cũ sẽ được backup)',
        };
      }
      return { line: 'Không truy cập được vault chứa key.', hint };
    }
    if (baseCode === 'P_AUTH') {
      return { line: 'Provider không chấp nhận API key — kiểm tra lại key đã nhập.', hint };
    }
    return { line: `Không khởi động được provider (${baseCode}).`, hint };
  }

  // English
  if (baseCode === 'U_MISSING_CONFIG') {
    if (reason === 'provider_key_missing' || reason === 'key_ref_unresolved') {
      return {
        line: `No API key${provider ? ` for ${provider}` : ''} is configured.`,
        hint,
      };
    }
    if (reason === 'no_active_workspace') {
      return { line: 'No active workspace — run `nimbus init` first.', hint };
    }
    if (reason === 'missing_passphrase') {
      return {
        line: 'Vault is locked — no passphrase available to unlock stored keys.',
        hint: hint ?? 'set NIMBUS_VAULT_PASSPHRASE or run `nimbus vault reset`',
      };
    }
    return { line: 'Missing configuration to start.', hint };
  }
  if (baseCode === 'X_CRED_ACCESS') {
    if (reason === 'vault_locked' || reason === 'tag_verify_fail') {
      return {
        line: 'Stored keys cannot be unlocked with the current passphrase (often after a binary upgrade).',
        hint: hint ?? 'restore your previous NIMBUS_VAULT_PASSPHRASE, or run `nimbus vault reset` to re-enter the key (old vault is backed up)',
      };
    }
    return { line: 'Could not access the key vault.', hint };
  }
  if (baseCode === 'P_AUTH') {
    return { line: 'Provider rejected the API key — please verify it.', hint };
  }
  return { line: `Could not start provider (${baseCode}).`, hint };
}
