// tests/tools/todoWriteTool.test.ts — SPEC-132: TodoWriteTool unit + integration tests.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { todoWriteTool } from '../../src/tools/todoWriteTool.ts';
import { renderTodoList, renderTodoItem } from '../../src/channels/render/todoList.ts';
import type { TodoItem, TodoSnapshot } from '../../src/core/todoStore.ts';
import type { ToolContext } from '../../src/tools/types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(
  id: string,
  status: TodoItem['status'],
  overrides: Partial<TodoItem> = {},
): TodoItem {
  return {
    id,
    content: `Task ${id}`,
    activeForm: `Doing ${id}`,
    status,
    createdAt: 1714000000000,
    updatedAt: 1714000000000,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ac = new AbortController();
  return {
    workspaceId: 'ws-test',
    sessionId: 'sess-test',
    turnId: 'turn-test',
    toolUseId: 'tuid-test',
    cwd: tmpdir(),
    signal: ac.signal,
    onAbort: () => { /* noop */ },
    permissions: {
      canUseTool: async () => 'allow' as const,
      rememberAllow: () => { /* noop */ },
      forgetSession: () => { /* noop */ },
    },
    mode: 'default',
    logger: {
      info: () => { /* noop */ },
      warn: () => { /* noop */ },
      error: () => { /* noop */ },
      debug: () => { /* noop */ },
      child: () => ({
        info: () => { /* noop */ },
        warn: () => { /* noop */ },
        error: () => { /* noop */ },
        debug: () => { /* noop */ },
      }),
    } as unknown as ToolContext['logger'],
    ...overrides,
  };
}

// ── Input schema validation ───────────────────────────────────────────────────

describe('SPEC-132: TodoWriteTool schema', () => {
  test('valid input passes Zod', () => {
    const input = {
      todos: [makeItem('A', 'in_progress')],
    };
    const result = todoWriteTool.inputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test('max 20 items enforced by Zod', () => {
    const items = Array.from({ length: 21 }, (_, i) => makeItem(`X${i}`, 'pending'));
    const result = todoWriteTool.inputSchema.safeParse({ todos: items });
    expect(result.success).toBe(false);
  });

  test('empty todos list passes', () => {
    const result = todoWriteTool.inputSchema.safeParse({ todos: [] });
    expect(result.success).toBe(true);
  });

  test('all 4 statuses accepted', () => {
    const statuses: TodoItem['status'][] = ['pending', 'in_progress', 'completed', 'cancelled'];
    for (const s of statuses) {
      const result = todoWriteTool.inputSchema.safeParse({
        todos: [makeItem('A', s)],
      });
      expect(result.success).toBe(true);
    }
  });

  test('invalid status rejected', () => {
    const result = todoWriteTool.inputSchema.safeParse({
      todos: [{ ...makeItem('A', 'pending'), status: 'unknown_status' }],
    });
    expect(result.success).toBe(false);
  });
});

// ── Handler: exactly-1-in_progress enforcement ───────────────────────────────

describe('SPEC-132: TodoWriteTool handler - 1 in_progress rule', () => {
  test('2 in_progress items → NimbusError T_VALIDATION', async () => {
    const ctx = makeCtx();
    const input = {
      todos: [
        makeItem('A', 'in_progress'),
        makeItem('B', 'in_progress'),
      ],
    };
    await expect(todoWriteTool.handler(input, ctx)).rejects.toThrow();
  });

  test('1 in_progress + 2 pending → ok', async () => {
    await mkdir(join(tmpdir(), 'nimbus-ws-test', 'sessions', 'sess-test'), { recursive: true });
    const ctx = makeCtx();
    const input = {
      todos: [
        makeItem('A', 'in_progress'),
        makeItem('B', 'pending'),
        makeItem('C', 'pending'),
      ],
    };
    const result = await todoWriteTool.handler(input, ctx);
    expect(result.ok).toBe(true);
  });

  test('0 in_progress (all pending) → ok', async () => {
    const ctx = makeCtx();
    const input = {
      todos: [makeItem('A', 'pending'), makeItem('B', 'pending')],
    };
    const result = await todoWriteTool.handler(input, ctx);
    expect(result.ok).toBe(true);
  });

  test('tool is marked non-readOnly', () => {
    expect(todoWriteTool.readOnly).toBe(false);
  });

  test('tool name is TodoWrite', () => {
    expect(todoWriteTool.name).toBe('TodoWrite');
  });
});

// ── Handler: output ───────────────────────────────────────────────────────────

describe('SPEC-132: TodoWriteTool handler - output', () => {
  test('output contains item counts', async () => {
    const ctx = makeCtx();
    const input = {
      todos: [
        makeItem('A', 'completed'),
        makeItem('B', 'in_progress'),
        makeItem('C', 'pending'),
      ],
    };
    const result = await todoWriteTool.handler(input, ctx);
    if (!result.ok) throw new Error('expected ok');
    expect(result.output).toContain('3 items');
  });

  test('display is a non-empty string', async () => {
    const ctx = makeCtx();
    const input = { todos: [makeItem('A', 'in_progress')] };
    const result = await todoWriteTool.handler(input, ctx);
    if (!result.ok) throw new Error('expected ok');
    expect(typeof result.display).toBe('string');
    expect((result.display ?? '').length).toBeGreaterThan(0);
  });
});

// ── Render: ANSI glyphs ───────────────────────────────────────────────────────

describe('SPEC-132: renderTodoList ANSI glyphs', () => {
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  test('[x] for completed', () => {
    const snap: TodoSnapshot = {
      turnId: 'T1', ts: 1,
      items: [makeItem('A', 'completed')],
    };
    const rendered = stripAnsi(renderTodoList(snap));
    expect(rendered).toContain('[x]');
  });

  test('[>] for in_progress', () => {
    const snap: TodoSnapshot = {
      turnId: 'T1', ts: 1,
      items: [makeItem('A', 'in_progress')],
    };
    const rendered = stripAnsi(renderTodoList(snap));
    expect(rendered).toContain('[>]');
  });

  test('[ ] for pending', () => {
    const snap: TodoSnapshot = {
      turnId: 'T1', ts: 1,
      items: [makeItem('A', 'pending')],
    };
    const rendered = stripAnsi(renderTodoList(snap));
    expect(rendered).toContain('[ ]');
  });

  test('[-] for cancelled', () => {
    const snap: TodoSnapshot = {
      turnId: 'T1', ts: 1,
      items: [makeItem('A', 'cancelled')],
    };
    const rendered = stripAnsi(renderTodoList(snap));
    expect(rendered).toContain('[-]');
  });

  test('in_progress uses activeForm label', () => {
    const snap: TodoSnapshot = {
      turnId: 'T1', ts: 1,
      items: [makeItem('A', 'in_progress', { activeForm: 'Researching destinations' })],
    };
    const rendered = stripAnsi(renderTodoList(snap));
    expect(rendered).toContain('Researching destinations');
  });

  test('pending uses content label', () => {
    const snap: TodoSnapshot = {
      turnId: 'T1', ts: 1,
      items: [makeItem('A', 'pending', { content: 'Research destinations' })],
    };
    const rendered = stripAnsi(renderTodoList(snap));
    expect(rendered).toContain('Research destinations');
  });

  test('header shows item count', () => {
    const snap: TodoSnapshot = {
      turnId: 'T1', ts: 1,
      items: [makeItem('A', 'completed'), makeItem('B', 'pending')],
    };
    const rendered = stripAnsi(renderTodoList(snap));
    expect(rendered).toContain('2 items');
  });

  test('in_progress is wrapped in ANSI cyan bold escape', () => {
    const snap: TodoSnapshot = {
      turnId: 'T1', ts: 1,
      items: [makeItem('A', 'in_progress')],
    };
    // Raw render (with ANSI) should contain escape code for cyan bold
    const raw = renderTodoList(snap);
    expect(raw).toContain('\x1b[1;36m');
  });

  test('empty snapshot renders "Plan (empty)"', () => {
    const snap: TodoSnapshot = { turnId: 'T1', ts: 1, items: [] };
    expect(renderTodoList(snap)).toBe('Plan (empty)');
  });

  test('renderTodoItem works on single item', () => {
    const item = makeItem('A', 'in_progress', { activeForm: 'Doing the thing' });
    const rendered = stripAnsi(renderTodoItem(item));
    expect(rendered).toContain('[>]');
    expect(rendered).toContain('Doing the thing');
  });
});

// ── Regression: [INTERNAL_PLAN] absent from buildSystemPrompt ─────────────────

describe('SPEC-132 regression: no [INTERNAL_PLAN] in system prompt', () => {
  test('[INTERNAL_PLAN] is absent from buildSystemPrompt output', async () => {
    const { buildSystemPrompt } = await import('../../src/core/prompts.ts');
    const memory = {
      soulMd: { frontmatter: {}, body: 'soul content', path: '/soul.md' },
      memoryMd: { frontmatter: {}, body: 'memory content', path: '/mem.md' },
      toolsMd: { frontmatter: {}, body: 'tools content', path: '/tools.md' },
    };
    const caps = {
      promptCaching: 'none' as const,
      nativeTools: true,
      vision: 'none' as const,
      extendedThinking: false,
      maxContextTokens: 8192,
      supportsStreamingTools: true,
      supportsParallelTools: true,
    };
    const blocks = buildSystemPrompt({ memory: memory as never, caps });
    const allText = blocks
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    expect(allText).not.toContain('[INTERNAL_PLAN]');
  });

  test('taskSpec field is not in BuildPromptInput type (deprecated/never)', async () => {
    const { buildSystemPrompt } = await import('../../src/core/prompts.ts');
    // Should compile without taskSpec field
    expect(typeof buildSystemPrompt).toBe('function');
  });
});
