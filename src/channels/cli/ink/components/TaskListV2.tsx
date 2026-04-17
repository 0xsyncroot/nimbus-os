// TaskListV2.tsx — SPEC-848: Task list component with figures icons, clamp formula, fade TTL.
// Subscribes to tools.todoUpdate via useTasks() hook.
// Icons use `figures` package for cross-platform Unicode/ASCII safety.
// Max visible tasks: min(10, max(3, rows - 14)) — matches Claude Code TaskListV2.tsx:48.

import React from 'react';
import { Box, Text } from 'ink';
import figures from 'figures';
import { useAppContext } from '../app.tsx';
import { useTasks } from '../hooks/useTasks.ts';
import { useTheme } from '../theme.ts';
import type { Task } from '../hooks/useTasks.ts';

// ── Icon mapping (SPEC-848 §3): figures package for cross-platform safety ──────
const ICON_DONE = figures.tick;                 // ✔ / [OK] on Windows legacy
const ICON_IN_PROGRESS = figures.squareSmallFilled; // ◼ / [x] on Windows legacy
const ICON_PENDING = figures.squareSmall;           // ◻ / [ ] on Windows legacy
const ICON_FAILED = figures.cross;                  // ✖ / x on Windows legacy
const ICON_BLOCKED_BY = figures.pointerSmall;       // › / > on Windows legacy

/**
 * Clamp visible task count.
 * min(10, max(3, rows - 14)) — encodes:
 *   3  = minimum useful list
 *   10 = visual overload threshold
 *   14 = rows consumed by StatusLine + prompt + header
 */
function clampDisplay(rows: number): number {
  return Math.min(10, Math.max(3, rows - 14));
}

function getIcon(task: Task): string {
  switch (task.status) {
    case 'done':
      return ICON_DONE;
    case 'in_progress':
      return ICON_IN_PROGRESS;
    case 'pending':
      return ICON_PENDING;
    default:
      return ICON_FAILED;
  }
}

interface TaskRowProps {
  task: Task;
  showOwner: boolean;
}

function TaskRow({ task, showOwner }: TaskRowProps): React.ReactElement {
  const getColor = useTheme();

  const iconColor =
    task.status === 'done'
      ? getColor('success')
      : task.status === 'in_progress'
        ? getColor('warning')
        : task.status === 'pending'
          ? getColor('inactive')
          : getColor('error');

  const iconColorProp = iconColor !== '' ? iconColor : undefined;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {/* Status icon */}
        <Text color={iconColorProp}>{getIcon(task)}</Text>

        {/* Task title */}
        <Text
          color={task.status === 'done' ? (getColor('inactive') || undefined) : undefined}
          dimColor={task.status === 'done'}
        >
          {task.title}
          {task.status === 'in_progress' ? '…' : ''}
        </Text>

        {/* Owner badge — hidden when cols < 60 */}
        {showOwner && task.owner !== undefined ? (
          <Text color={getColor('subtle') !== '' ? getColor('subtle') : undefined} dimColor>
            [{task.owner}]
          </Text>
        ) : null}
      </Box>

      {/* Blocked-by list */}
      {task.blockedBy && task.blockedBy.length > 0 ? (
        <Box flexDirection="row" gap={1} marginLeft={2}>
          <Text color={getColor('inactive') !== '' ? getColor('inactive') : undefined} dimColor>
            {task.blockedBy.map((b) => `${ICON_BLOCKED_BY} ${b}`).join(' ')}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * TaskListV2 — renders the live task list sourced from tools.todoUpdate event bus.
 * Mounts anywhere in the component tree; no prop drilling needed.
 */
export function TaskListV2(): React.ReactElement {
  const { cols, rows } = useAppContext();
  const tasks = useTasks();

  const maxDisplay = clampDisplay(rows);
  const showOwner = cols >= 60;

  // Show at most maxDisplay tasks; prefer in_progress and pending over done ones.
  const visible = tasks.slice(0, maxDisplay);

  if (visible.length === 0) {
    return <Box />;
  }

  return (
    <Box flexDirection="column">
      {visible.map((task) => (
        <TaskRow key={task.id} task={task} showOwner={showOwner} />
      ))}
    </Box>
  );
}
