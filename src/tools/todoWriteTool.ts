// todoWriteTool.ts — SPEC-132: TodoWriteTool — full-list replacement plan management.
//
// SPEC-833: tools layer must NOT import src/channels/** (META-001 §2.2).
// Removed renderTodoList() import — tool returns structured plain-text summary.
// Each channel formats the TodoSnapshot in its native form:
//   CLI: src/channels/render/todoList.ts (ANSI) — called by render.ts when it
//        intercepts the tool_result display text or the tool_end event.
//   Telegram/HTTP: future — render plain text or Markdown from the snapshot.

import { z } from 'zod';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { TodoItemSchema, TodoSnapshotSchema, todoStore, validateSnapshot } from '../core/todoStore.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';

// ── Input schema ─────────────────────────────────────────────────────────────

export const TodoWriteInputSchema = z.object({
  todos: z.array(TodoItemSchema).max(20, 'max 20 todo items per list'),
});
export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

// ── Handler ──────────────────────────────────────────────────────────────────

async function handler(
  input: TodoWriteInput,
  ctx: ToolContext,
): Promise<ToolResult<string>> {
  const snapshot = TodoSnapshotSchema.parse({
    turnId: ctx.turnId,
    items: input.todos,
    ts: Date.now(),
  });

  // Enforce exactly-1-in_progress at tool level (defense in depth)
  try {
    validateSnapshot(snapshot);
  } catch (err) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'todo_validation_failed',
      message: (err as Error).message,
    });
  }

  await todoStore.append(ctx.workspaceId, ctx.sessionId, snapshot);

  // display = plain-text summary returned to the model in the tool_result block.
  // ANSI rendering happens at the channel layer (src/channels/render/todoList.ts),
  // NOT here — keeping tools pure per META-001 §2.2.
  const summary = buildSummary(snapshot);

  return { ok: true, output: summary, display: summary };
}

function buildSummary(snapshot: ReturnType<typeof TodoSnapshotSchema.parse>): string {
  const total = snapshot.items.length;
  const done = snapshot.items.filter((i) => i.status === 'completed').length;
  const active = snapshot.items.filter((i) => i.status === 'in_progress').length;
  const pending = snapshot.items.filter((i) => i.status === 'pending').length;
  const cancelled = snapshot.items.filter((i) => i.status === 'cancelled').length;
  const parts: string[] = [`${total} items`];
  if (done > 0) parts.push(`${done} completed`);
  if (active > 0) parts.push(`${active} active`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  return `Todo list updated (${parts.join(' · ')})`;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const todoWriteTool: Tool<TodoWriteInput, string> = {
  name: 'TodoWrite',
  description:
    'Replace the current todo list with a complete new snapshot. Use for tasks with 3+ steps. ' +
    'Always send the FULL list — omitting an item removes it. ' +
    'Mark in_progress BEFORE starting work; mark completed IMMEDIATELY after success. ' +
    'Only 1 item may be in_progress at a time.',
  inputSchema: TodoWriteInputSchema,
  readOnly: false,
  dangerous: false,
  handler,
};
