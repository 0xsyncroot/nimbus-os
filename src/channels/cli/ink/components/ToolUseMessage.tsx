// ToolUseMessage.tsx — SPEC-843: Tool-use block header with platform glyph.
// Shows TOOL_USE_GLYPH (⏺ darwin / ● else) + tool name + formatted args summary.
// Supports a per-tool renderer registry for custom arg formatting.
// SpinnerWithVerb shown during pending state.

import React from 'react';
import { Box, Text } from 'ink';
import { TOOL_USE_GLYPH } from '../constants/figures.ts';
import { SpinnerWithVerb } from './SpinnerWithVerb.tsx';
import { useTheme } from '../theme.ts';

// ── Per-tool renderer registry ────────────────────────────────────────────────
export type ToolArgRenderer = (input: unknown) => string;

const toolArgRegistry = new Map<string, ToolArgRenderer>();

/**
 * registerToolRenderer — registers a custom args formatter for a specific tool.
 * Called externally (e.g., SPEC-844 registers diff renderer for Write/Edit tools).
 */
export function registerToolRenderer(name: string, fn: ToolArgRenderer): void {
  toolArgRegistry.set(name, fn);
}

/**
 * getToolRenderer — returns the registered renderer or the default.
 */
export function getToolRenderer(name: string): ToolArgRenderer {
  return toolArgRegistry.get(name) ?? defaultArgRenderer;
}

/**
 * defaultArgRenderer — formats tool input as a compact JSON summary.
 * Truncates long strings to 80 chars to keep the UI clean.
 */
function defaultArgRenderer(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') {
    return input.length > 80 ? `${input.slice(0, 80)}…` : input;
  }
  if (typeof input === 'object') {
    try {
      const s = JSON.stringify(input);
      return s.length > 80 ? `${s.slice(0, 80)}…` : s;
    } catch {
      return '[complex input]';
    }
  }
  return String(input);
}

// ── Tool state ────────────────────────────────────────────────────────────────
export type ToolUseState = 'pending' | 'running' | 'done' | 'error';

// ── Props ─────────────────────────────────────────────────────────────────────
export interface ToolUseMessageProps {
  toolName: string;
  input: unknown;
  state: ToolUseState;
  /** Seconds since tool invocation — used for stall detection. */
  stallSecs?: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ToolUseMessage({
  toolName,
  input,
  state,
  stallSecs = 0,
}: ToolUseMessageProps): React.ReactElement {
  const getColor = useTheme();
  const renderer = getToolRenderer(toolName);
  const argSummary = renderer(input);

  const isStalled = stallSecs >= 3;

  // Glyph color based on state
  const glyphColor = state === 'error'
    ? getColor('error')
    : state === 'done'
      ? getColor('success')
      : getColor('claude');

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={glyphColor}>{TOOL_USE_GLYPH}</Text>
        <Text color={getColor('text')} bold>{toolName}</Text>
        {argSummary ? (
          <Text color={getColor('inactive')}>{argSummary}</Text>
        ) : null}
      </Box>

      {/* Show spinner while tool is running/pending */}
      {(state === 'pending' || state === 'running') ? (
        <Box marginLeft={2}>
          <SpinnerWithVerb
            verb="Running"
            stalled={isStalled}
            stallSecs={stallSecs}
          />
        </Box>
      ) : null}
    </Box>
  );
}
