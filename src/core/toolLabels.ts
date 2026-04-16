// toolLabels.ts — SPEC-826 T1: map tool name + input → human label (VN + EN).
// Lives in src/core/ so loop.ts can import it without crossing channel boundary.

export type Locale = 'vi' | 'en';

/** Detect locale from NIMBUS_LANG override or LANG env. */
export function detectLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const override = env['NIMBUS_LANG'];
  if (override === 'vi' || override === 'en') return override;
  const lang = env['LANG'] ?? '';
  return lang.startsWith('vi') ? 'vi' : 'en';
}

/** Truncate string to maxLen chars, appending … if truncated. */
function trunc(s: string, maxLen = 40): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '\u2026';
}

/** Safely extract a string field from an unknown record. */
function str(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/** Safely extract array length from a field. */
function arrLen(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (Array.isArray(v)) return v.length;
  return 0;
}

/** Extract URL hostname safely (no path / query to avoid leaking tokens). */
function hostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '(url)';
  }
}

const LABELS_VN: Record<string, (args: Record<string, unknown>) => string> = {
  Write:      (a) => `ghi file ${trunc(str(a, 'path', 'file_path'))}`,
  Edit:       (a) => `sửa ${trunc(str(a, 'path', 'file_path'))}`,
  Read:       (a) => `đọc ${trunc(str(a, 'path', 'file_path'))}`,
  Grep:       (a) => `tìm "${trunc(str(a, 'pattern'))}"`,
  Glob:       (a) => `liệt kê ${trunc(str(a, 'pattern'))}`,
  Bash:       (a) => `chạy: ${trunc(str(a, 'command'))}`,
  WebSearch:  (a) => `tìm web: ${trunc(str(a, 'query'))}`,
  WebFetch:   (a) => `tải ${hostname(str(a, 'url'))}`,
  TodoWrite:  (a) => `cập nhật plan (${arrLen(a, 'todos')} mục)`,
  MemoryTool: (_) => 'ghi chú vào memory',
  AgentTool:  (_) => 'giao việc cho sub-agent',
  Skill:      (a) => `dùng skill: ${trunc(str(a, 'skill', 'name'))}`,
};

const LABELS_EN: Record<string, (args: Record<string, unknown>) => string> = {
  Write:      (a) => `writing ${trunc(str(a, 'path', 'file_path'))}`,
  Edit:       (a) => `editing ${trunc(str(a, 'path', 'file_path'))}`,
  Read:       (a) => `reading ${trunc(str(a, 'path', 'file_path'))}`,
  Grep:       (a) => `searching for "${trunc(str(a, 'pattern'))}"`,
  Glob:       (a) => `listing ${trunc(str(a, 'pattern'))}`,
  Bash:       (a) => `running: ${trunc(str(a, 'command'))}`,
  WebSearch:  (a) => `searching web: ${trunc(str(a, 'query'))}`,
  WebFetch:   (a) => `fetching ${hostname(str(a, 'url'))}`,
  TodoWrite:  (a) => `updating plan (${arrLen(a, 'todos')} items)`,
  MemoryTool: (_) => 'updating memory',
  AgentTool:  (_) => 'delegating to sub-agent',
  Skill:      (a) => `running skill: ${trunc(str(a, 'skill', 'name'))}`,
};

/**
 * Map a tool name + input args to a human-readable label.
 * O(1) lookup. Returns locale-specific fallback for unknown tools.
 */
export function formatToolLabel(
  toolName: string,
  args: Record<string, unknown>,
  locale: Locale,
): string {
  const map = locale === 'vi' ? LABELS_VN : LABELS_EN;
  const fn = map[toolName];
  if (fn) return fn(args);
  return locale === 'vi' ? `dùng công cụ: ${toolName}` : `using tool: ${toolName}`;
}

/** Alias: humanizeToolInvocation — matches spec interface name */
export function humanizeToolInvocation(
  name: string,
  input: unknown,
  locale: Locale = detectLocale(),
): string {
  const args = (input !== null && typeof input === 'object' && !Array.isArray(input))
    ? (input as Record<string, unknown>)
    : {};
  return formatToolLabel(name, args, locale);
}
