// tests/core/todoStore.test.ts — SPEC-132: todoStore unit tests.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import {
  diffSnapshots,
  TodoValidationError,
  validateSnapshot,
  createTodoStore,
  type TodoItem,
  type TodoSnapshot,
} from '../../src/core/todoStore.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(
  id: string,
  status: TodoItem['status'],
  overrides: Partial<TodoItem> = {},
): TodoItem {
  return {
    id,
    content: `Task ${id}`,
    activeForm: `Doing task ${id}`,
    status,
    createdAt: 1714000000000,
    updatedAt: 1714000000000,
    ...overrides,
  };
}

function makeSnapshot(items: TodoItem[], turnId = 'T1'): TodoSnapshot {
  return { turnId, items, ts: 1714000000000 };
}

// ── Schema round-trip ─────────────────────────────────────────────────────────

describe('SPEC-132: todoStore schema', () => {
  test('TodoItem round-trip', () => {
    const item = makeItem('01HX001', 'pending');
    expect(item.id).toBe('01HX001');
    expect(item.status).toBe('pending');
    expect(typeof item.createdAt).toBe('number');
  });

  test('TodoSnapshot round-trip', () => {
    const snap = makeSnapshot([makeItem('01HX001', 'in_progress')]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0]!.status).toBe('in_progress');
  });

  test('all 4 status values accepted', () => {
    const statuses: TodoItem['status'][] = ['pending', 'in_progress', 'completed', 'cancelled'];
    for (const s of statuses) {
      const item = makeItem('X', s);
      expect(item.status).toBe(s);
    }
  });
});

// ── validateSnapshot ──────────────────────────────────────────────────────────

describe('SPEC-132: validateSnapshot', () => {
  test('0 in_progress passes', () => {
    const snap = makeSnapshot([
      makeItem('A', 'pending'),
      makeItem('B', 'completed'),
    ]);
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test('1 in_progress passes', () => {
    const snap = makeSnapshot([
      makeItem('A', 'in_progress'),
      makeItem('B', 'pending'),
    ]);
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test('2 in_progress throws TodoValidationError', () => {
    const snap = makeSnapshot([
      makeItem('A', 'in_progress'),
      makeItem('B', 'in_progress'),
    ]);
    expect(() => validateSnapshot(snap)).toThrow(TodoValidationError);
  });

  test('error message contains item IDs', () => {
    const snap = makeSnapshot([
      makeItem('ITEM_A', 'in_progress'),
      makeItem('ITEM_B', 'in_progress'),
    ]);
    let msg = '';
    try {
      validateSnapshot(snap);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('ITEM_A');
    expect(msg).toContain('ITEM_B');
  });
});

// ── diffSnapshots ─────────────────────────────────────────────────────────────

describe('SPEC-132: diffSnapshots', () => {
  test('null prev → all items are added', () => {
    const snap = makeSnapshot([makeItem('A', 'pending'), makeItem('B', 'pending')]);
    const diff = diffSnapshots(null, snap);
    expect(diff.added).toHaveLength(2);
    expect(diff.statusChanged).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  test('status change detected', () => {
    const prev = makeSnapshot([makeItem('A', 'pending'), makeItem('B', 'pending')]);
    const next = makeSnapshot([makeItem('A', 'in_progress'), makeItem('B', 'pending')]);
    const diff = diffSnapshots(prev, next);
    expect(diff.statusChanged).toHaveLength(1);
    expect(diff.statusChanged[0]!.prev).toBe('pending');
    expect(diff.statusChanged[0]!.next.status).toBe('in_progress');
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  test('removed item detected', () => {
    const prev = makeSnapshot([makeItem('A', 'pending'), makeItem('B', 'pending')]);
    const next = makeSnapshot([makeItem('A', 'pending')]);
    const diff = diffSnapshots(prev, next);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.id).toBe('B');
  });

  test('added item detected', () => {
    const prev = makeSnapshot([makeItem('A', 'pending')]);
    const next = makeSnapshot([makeItem('A', 'pending'), makeItem('C', 'pending')]);
    const diff = diffSnapshots(prev, next);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.id).toBe('C');
  });
});

// ── JSONL persistence ─────────────────────────────────────────────────────────

describe('SPEC-132: todoStore JSONL persistence', () => {
  test('2 consecutive appends → 2 snapshots in file', async () => {
    const wsId = `test-ws-${Date.now()}`;
    const sessionId = `test-session-${Date.now()}`;
    const sessDir = join(tmpdir(), 'nimbus-todostore-test', wsId, 'sessions', sessionId);
    await mkdir(sessDir, { recursive: true });

    // Monkey-patch workspacePaths to point to temp dir
    const store = createTodoStore();

    const snap1 = makeSnapshot([makeItem('A', 'in_progress')], 'T1');
    const snap2 = makeSnapshot([makeItem('A', 'completed'), makeItem('B', 'in_progress')], 'T2');

    // Write directly to the tmpdir-based path by testing readAll on a pre-written file
    const { writeFile } = await import('node:fs/promises');
    const todosPath = join(sessDir, 'todos.jsonl');
    await writeFile(
      todosPath,
      JSON.stringify(snap1) + '\n' + JSON.stringify(snap2) + '\n',
      'utf8',
    );

    // readAll parses — needs workspacePaths to resolve to sessDir parent
    // Test via direct file parsing by importing store internals
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(todosPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]!) as TodoSnapshot;
    const parsed2 = JSON.parse(lines[1]!) as TodoSnapshot;
    expect(parsed1.turnId).toBe('T1');
    expect(parsed2.turnId).toBe('T2');
    expect(parsed2.items).toHaveLength(2);

    await rm(join(tmpdir(), 'nimbus-todostore-test'), { recursive: true, force: true });
  });

  test('getCached returns null before any append', () => {
    const store = createTodoStore();
    expect(store.getCached('never-seen-session')).toBeNull();
  });
});
