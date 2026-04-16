import { describe, expect, test } from 'bun:test';
import { formatToolLabel, detectLocale, humanizeToolInvocation } from '../../src/core/toolLabels.ts';

describe('SPEC-826: toolLabels — humanize tool invocations', () => {
  // ── VN labels (v0.3.4: include "đang" verb inline) ────────────────────────────

  test('Write → đang ghi file {path} (vi)', () => {
    expect(formatToolLabel('Write', { path: '/tmp/bot.py' }, 'vi')).toBe('đang ghi file /tmp/bot.py');
  });

  test('Edit → đang sửa {path} (vi)', () => {
    expect(formatToolLabel('Edit', { file_path: '/src/main.ts' }, 'vi')).toBe('đang sửa /src/main.ts');
  });

  test('Read → đang đọc {path} (vi)', () => {
    expect(formatToolLabel('Read', { path: '/etc/hosts' }, 'vi')).toBe('đang đọc /etc/hosts');
  });

  test('Grep → đang tìm "{pattern}" (vi)', () => {
    expect(formatToolLabel('Grep', { pattern: 'TODO' }, 'vi')).toBe('đang tìm "TODO"');
  });

  test('Glob → đang liệt kê {pattern} (vi)', () => {
    expect(formatToolLabel('Glob', { pattern: '**/*.ts' }, 'vi')).toBe('đang liệt kê **/*.ts');
  });

  test('TodoWrite → đang cập nhật plan (3 mục) (vi)', () => {
    expect(formatToolLabel('TodoWrite', { todos: [1, 2, 3] }, 'vi')).toBe('đang cập nhật plan (3 mục)');
  });

  test('MemoryTool → đang ghi chú vào memory (vi)', () => {
    expect(formatToolLabel('MemoryTool', {}, 'vi')).toBe('đang ghi chú vào memory');
  });

  test('AgentTool → đang giao việc cho sub-agent (vi)', () => {
    expect(formatToolLabel('AgentTool', {}, 'vi')).toBe('đang giao việc cho sub-agent');
  });

  test('MultiEdit → đang sửa nhiều chỗ trong {path} (vi)', () => {
    expect(formatToolLabel('MultiEdit', { path: '/src/app.ts' }, 'vi')).toBe(
      'đang sửa nhiều chỗ trong /src/app.ts',
    );
  });

  test('NotebookEdit → đang sửa notebook {path} (vi)', () => {
    expect(formatToolLabel('NotebookEdit', { path: '/work/nb.ipynb' }, 'vi')).toBe(
      'đang sửa notebook /work/nb.ipynb',
    );
  });

  // ── EN labels ────────────────────────────────────────────────────────────────

  test('Write → writing {path} (en)', () => {
    expect(formatToolLabel('Write', { path: '/tmp/bot.py' }, 'en')).toBe('writing /tmp/bot.py');
  });

  test('Edit → editing {path} (en)', () => {
    expect(formatToolLabel('Edit', { file_path: '/src/main.ts' }, 'en')).toBe('editing /src/main.ts');
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

  // ── v0.3.4 Bug A regression: labels must NOT start with an EN gerund
  //    in the VN path, and NOT start with "đang" in the EN path. ────────────────

  test('VN label always starts with "đang " (Bug A regression)', () => {
    for (const name of [
      'Write', 'Edit', 'MultiEdit', 'Read', 'Grep', 'Glob', 'Ls',
      'Bash', 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookEdit',
      'MemoryTool', 'AgentTool', 'Skill',
    ]) {
      const label = formatToolLabel(name, { path: 'x', command: 'y', pattern: 'p', url: 'https://a.b', query: 'q', skill: 's', name: 's', todos: [] }, 'vi');
      expect(label.startsWith('đang ')).toBe(true);
    }
  });

  test('EN label never contains "đang" (Bug A regression)', () => {
    for (const name of [
      'Write', 'Edit', 'MultiEdit', 'Read', 'Grep', 'Glob', 'Ls',
      'Bash', 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookEdit',
      'MemoryTool', 'AgentTool', 'Skill',
    ]) {
      const label = formatToolLabel(name, { path: 'x', command: 'y', pattern: 'p', url: 'https://a.b', query: 'q', skill: 's', name: 's', todos: [] }, 'en');
      expect(label).not.toContain('đang');
      // Must not be entirely empty either.
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test('Unknown tool fallback VN starts with "đang " (Bug A regression)', () => {
    expect(formatToolLabel('CustomPlugin', {}, 'vi').startsWith('đang ')).toBe(true);
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
    expect(formatToolLabel('Bash', { command: 'ls -la' }, 'vi')).toBe('đang chạy: ls -la');
  });

  test('Bash accepts "cmd" key alias (vi)', () => {
    expect(formatToolLabel('Bash', { cmd: 'ls -la' }, 'vi')).toBe('đang chạy: ls -la');
  });

  // ── WebFetch hostname extraction ──────────────────────────────────────────────

  test('WebFetch → đang tải {hostname} only, no path or query (vi)', () => {
    expect(formatToolLabel('WebFetch', { url: 'https://api.x.com/v1?token=ABC' }, 'vi')).toBe(
      'đang tải api.x.com',
    );
  });

  test('WebFetch → fetching {hostname} (en)', () => {
    expect(formatToolLabel('WebFetch', { url: 'https://api.x.com/v1?token=ABC' }, 'en')).toBe('fetching api.x.com');
  });

  test('WebFetch with invalid URL → fallback (vi)', () => {
    expect(formatToolLabel('WebFetch', { url: 'not-a-url' }, 'vi')).toBe('đang tải (url)');
  });

  // ── WebSearch ────────────────────────────────────────────────────────────────

  test('WebSearch → đang tìm web: {query} (vi)', () => {
    expect(formatToolLabel('WebSearch', { query: 'nimbus os' }, 'vi')).toBe('đang tìm web: nimbus os');
  });

  // ── Skill ────────────────────────────────────────────────────────────────────

  test('Skill → đang dùng skill: {name} (vi)', () => {
    expect(formatToolLabel('Skill', { name: 'pdf' }, 'vi')).toBe('đang dùng skill: pdf');
  });

  // ── fallback for unknown tools ───────────────────────────────────────────────

  test('unknown tool → đang dùng công cụ: {name} (vi)', () => {
    expect(formatToolLabel('CustomTool', {}, 'vi')).toBe('đang dùng công cụ: CustomTool');
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

  test('detectLocale defaults to en when LANG=C.UTF-8 (server default)', () => {
    expect(detectLocale({ LANG: 'C.UTF-8' })).toBe('en');
  });

  // ── humanizeToolInvocation (alias) ───────────────────────────────────────────

  test('humanizeToolInvocation wraps non-object input safely', () => {
    expect(humanizeToolInvocation('MemoryTool', null, 'vi')).toBe('đang ghi chú vào memory');
  });

  test('humanizeToolInvocation with string input falls back safely', () => {
    expect(humanizeToolInvocation('Write', 'not-an-object', 'en')).toBe('writing ');
  });
});
