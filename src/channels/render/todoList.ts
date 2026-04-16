// todoList.ts — SPEC-132: ANSI checklist renderer for TodoSnapshot.

import type { TodoItem, TodoSnapshot, TodoStatus } from '../../core/todoStore.ts';

// ── ANSI escape codes ─────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const CYAN_BOLD = '\x1b[1;36m';
const DIM = '\x1b[2m';
const STRIKETHROUGH = '\x1b[9m';

// ── Glyph map ─────────────────────────────────────────────────────────────────

const GLYPHS: Record<TodoStatus, string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
  cancelled: '[-]',
};

// ── Item renderer ─────────────────────────────────────────────────────────────

function renderItem(item: TodoItem): string {
  const glyph = GLYPHS[item.status];
  const label = item.status === 'in_progress' ? item.activeForm : item.content;

  switch (item.status) {
    case 'in_progress':
      return `  ${CYAN_BOLD}${glyph} ${label}${RESET}`;
    case 'completed':
      return `  ${DIM}${STRIKETHROUGH}${glyph} ${label}${RESET}`;
    case 'cancelled':
      return `  ${DIM}${STRIKETHROUGH}${glyph} ${label}${RESET}`;
    case 'pending':
      return `  ${glyph} ${label}`;
    default: {
      const _exhaustive: never = item.status;
      return `  ${glyph} ${label}${_exhaustive}`;
    }
  }
}

// ── Header line ───────────────────────────────────────────────────────────────

function renderHeader(items: TodoItem[]): string {
  const total = items.length;
  const done = items.filter((i) => i.status === 'completed').length;
  const active = items.filter((i) => i.status === 'in_progress').length;
  const parts: string[] = [`${total} item${total !== 1 ? 's' : ''}`];
  if (done > 0) parts.push(`${done} done`);
  if (active > 0) parts.push(`${active} active`);
  return `Plan (${parts.join(' · ')})`;
}

// ── Public render ─────────────────────────────────────────────────────────────

/**
 * Renders a TodoSnapshot as an ANSI-formatted checklist string.
 *
 * Example output:
 *   Plan (3 items · 1 done · 1 active)
 *     [x] Research destinations under 10M VND
 *     [>] Compare prices for 3 options         ← cyan bold
 *     [ ] Recommend top pick with breakdown
 */
export function renderTodoList(snapshot: TodoSnapshot): string {
  if (snapshot.items.length === 0) {
    return 'Plan (empty)';
  }
  const lines: string[] = [
    renderHeader(snapshot.items),
    ...snapshot.items.map(renderItem),
  ];
  return lines.join('\n');
}

/**
 * Renders a single TodoItem for inline status updates.
 */
export function renderTodoItem(item: TodoItem): string {
  return renderItem(item);
}
