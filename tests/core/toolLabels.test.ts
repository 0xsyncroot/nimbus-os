import { describe, expect, test } from 'bun:test';
import { formatToolLabel, detectLocale, humanizeToolInvocation } from '../../src/core/toolLabels.ts';

describe('SPEC-826: toolLabels — humanize tool invocations', () => {
  // ── VN labels ────────────────────────────────────────────────────────────────

  test('Write → ghi file {path} (vi)', () => {
    expect(formatToolLabel('Write', { path: '/tmp/bot.py' }, 'vi')).toBe('ghi file /tmp/bot.py');
  });

  test('Edit → sửa {path} (vi)', () => {
    expect(formatToolLabel('Edit', { file_path: '/src/main.ts' }, 'vi')).toBe('sửa /src/main.ts');
  });

  test('Read → đọc {path} (vi)', () => {
    expect(formatToolLabel('Read', { path: '/etc/hosts' }, 'vi')).toBe('đọc /etc/hosts');
  });

  test('Grep → tìm "{pattern}" (vi)', () => {
    expect(formatToolLabel('Grep', { pattern: 'TODO' }, 'vi')).toBe('tìm "TODO"');
  });

  test('Glob → liệt kê {pattern} (vi)', () => {
    expect(formatToolLabel('Glob', { pattern: '**/*.ts' }, 'vi')).toBe('liệt kê **/*.ts');
  });

  test('TodoWrite → cập nhật plan (3 mục) (vi)', () => {
    expect(formatToolLabel('TodoWrite', { todos: [1, 2, 3] }, 'vi')).toBe('cập nhật plan (3 mục)');
  });

  test('MemoryTool → ghi chú vào memory (vi)', () => {
    expect(formatToolLabel('MemoryTool', {}, 'vi')).toBe('ghi chú vào memory');
  });

  test('AgentTool → giao việc cho sub-agent (vi)', () => {
    expect(formatToolLabel('AgentTool', {}, 'vi')).toBe('giao việc cho sub-agent');
  });

  // ── EN labels ────────────────────────────────────────────────────────────────

  test('Write → writing {path} (en)', () => {
    expect(formatToolLabel('Write', { path: '/tmp/bot.py' }, 'en')).toBe('writing /tmp/bot.py');
  });

  test('Read → reading {path} (en)', () => {
    expect(formatToolLabel('Read', { path: '/etc/hosts' }, 'en')).toBe('reading /etc/hosts');
  });

  test('Grep → searching for "{pattern}" (en)', () => {
    expect(formatToolLabel('Grep', { pattern: 'TODO' }, 'en')).toBe('searching for "TODO"');
  });

  test('MemoryTool → updating memory (en)', () => {
    expect(formatToolLabel('MemoryTool', {}, 'en')).toBe('updating memory');
  });

  // ── Truncation ───────────────────────────────────────────────────────────────

  test('Bash command truncated at 40 chars (en)', () => {
    // "ls -la /very/long/path/that/overflows/here" = 42 chars → sliced at 40 + ellipsis
    const result = formatToolLabel('Bash', { command: 'ls -la /very/long/path/that/overflows/here' }, 'en');
    // first 40 chars of command = "ls -la /very/long/path/that/overflows/he"
    expect(result).toBe('running: ls -la /very/long/path/that/overflows/he\u2026');
    expect(result).toContain('\u2026');
  });

  test('Bash command not truncated when short (vi)', () => {
    expect(formatToolLabel('Bash', { command: 'ls -la' }, 'vi')).toBe('chạy: ls -la');
  });

  // ── WebFetch hostname extraction ──────────────────────────────────────────────

  test('WebFetch → tải {hostname} only, no path or query (vi)', () => {
    expect(formatToolLabel('WebFetch', { url: 'https://api.x.com/v1?token=ABC' }, 'vi')).toBe('tải api.x.com');
  });

  test('WebFetch → fetching {hostname} (en)', () => {
    expect(formatToolLabel('WebFetch', { url: 'https://api.x.com/v1?token=ABC' }, 'en')).toBe('fetching api.x.com');
  });

  test('WebFetch with invalid URL → fallback (vi)', () => {
    expect(formatToolLabel('WebFetch', { url: 'not-a-url' }, 'vi')).toBe('tải (url)');
  });

  // ── WebSearch ────────────────────────────────────────────────────────────────

  test('WebSearch → tìm web: {query} (vi)', () => {
    expect(formatToolLabel('WebSearch', { query: 'nimbus os' }, 'vi')).toBe('tìm web: nimbus os');
  });

  // ── Skill ────────────────────────────────────────────────────────────────────

  test('Skill → dùng skill: {name} (vi)', () => {
    expect(formatToolLabel('Skill', { name: 'pdf' }, 'vi')).toBe('dùng skill: pdf');
  });

  // ── fallback for unknown tools ───────────────────────────────────────────────

  test('unknown tool → dùng công cụ: {name} (vi)', () => {
    expect(formatToolLabel('CustomTool', {}, 'vi')).toBe('dùng công cụ: CustomTool');
  });

  test('unknown tool → using tool: {name} (en)', () => {
    expect(formatToolLabel('CustomTool', {}, 'en')).toBe('using tool: CustomTool');
  });

  // ── detectLocale ─────────────────────────────────────────────────────────────

  test('detectLocale returns vi when NIMBUS_LANG=vi', () => {
    expect(detectLocale({ NIMBUS_LANG: 'vi' })).toBe('vi');
  });

  test('detectLocale returns en when NIMBUS_LANG=en', () => {
    expect(detectLocale({ NIMBUS_LANG: 'en' })).toBe('en');
  });

  test('detectLocale falls back to LANG=vi_VN.UTF-8', () => {
    expect(detectLocale({ LANG: 'vi_VN.UTF-8' })).toBe('vi');
  });

  test('detectLocale defaults to en when LANG=en_US.UTF-8', () => {
    expect(detectLocale({ LANG: 'en_US.UTF-8' })).toBe('en');
  });

  // ── humanizeToolInvocation (alias) ───────────────────────────────────────────

  test('humanizeToolInvocation wraps non-object input safely', () => {
    expect(humanizeToolInvocation('MemoryTool', null, 'vi')).toBe('ghi chú vào memory');
  });

  test('humanizeToolInvocation with string input falls back safely', () => {
    expect(humanizeToolInvocation('Write', 'not-an-object', 'en')).toBe('writing ');
  });
});
