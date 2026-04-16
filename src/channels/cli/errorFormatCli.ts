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
};

const MAP_EN: Record<string, (ctx: Record<string, unknown>) => string> = {
  T_PERMISSION: (ctx) => {
    const sub = safeStr(ctx['reason']);
    if (sub === 'needs_confirm') {
      const action = safeStr(ctx['action'], 'this action');
      return `Paused — I need your permission to ${action}.`;
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
  return locale === 'vi'
    ? 'Công cụ lỗi — xem log với `--verbose`.'
    : 'Tool failed — run with `--verbose` for details.';
}
