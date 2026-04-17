// ToolResultMessage.tsx — SPEC-843: Tool result rendering with registry pattern.
// Extensible: SPEC-844 registers diff renderer for Write/Edit results.
// Default renderer handles text/string content. Per-tool renderers registered externally.

import React from 'react';
import { Box, Text } from 'ink';
import type { CanonicalBlock } from '../../../../ir/types.ts';
import { TICK_GLYPH, CROSS_GLYPH } from '../constants/figures.ts';
import { stripAnsiOsc } from './Markdown.tsx';
import { useTheme } from '../theme.ts';

// ── ToolResultBlock local type ────────────────────────────────────────────────
// Mirrors the CanonicalBlock tool_result variant for convenience.
export interface ToolResultBlock {
  toolUseId: string;
  toolName: string;
  content: string | CanonicalBlock[];
  isError?: boolean;
  trust?: 'trusted' | 'untrusted';
}

// ── Per-tool result renderer registry ────────────────────────────────────────
export type ToolResultRenderer = (result: ToolResultBlock) => React.ReactElement;

const toolResultRegistry = new Map<string, ToolResultRenderer>();

/**
 * registerToolResultRenderer — registers a custom result renderer for a tool.
 * Called externally (e.g., SPEC-844 for Write/Edit diff rendering).
 */
export function registerToolResultRenderer(
  toolName: string,
  renderer: ToolResultRenderer,
): void {
  toolResultRegistry.set(toolName, renderer);
}

// ── Content extractor ─────────────────────────────────────────────────────────
function extractText(content: string | CanonicalBlock[]): string {
  if (typeof content === 'string') return stripAnsiOsc(content);
  return content
    .map((block) => {
      if (block.type === 'text') return stripAnsiOsc(block.text);
      if (block.type === 'tool_result') {
        return typeof block.content === 'string'
          ? stripAnsiOsc(block.content)
          : '';
      }
      return '';
    })
    .join('\n')
    .trim();
}

// ── Default renderer ──────────────────────────────────────────────────────────
function DefaultToolResultRenderer({
  result,
}: {
  result: ToolResultBlock;
}): React.ReactElement {
  const getColor = useTheme();
  const isError = result.isError === true;
  const glyph = isError ? CROSS_GLYPH : TICK_GLYPH;
  const color = isError ? getColor('error') : getColor('success');
  const text = extractText(result.content);

  // Truncate long results for display — full content is in the conversation history
  const MAX_DISPLAY_CHARS = 500;
  const display = text.length > MAX_DISPLAY_CHARS
    ? `${text.slice(0, MAX_DISPLAY_CHARS)}\n… [truncated]`
    : text;

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={color}>{glyph}</Text>
        <Text color={getColor('inactive')}>{result.toolName}</Text>
        {isError ? (
          <Text color={getColor('error')} bold>failed</Text>
        ) : (
          <Text color={getColor('success')}>done</Text>
        )}
      </Box>
      {display ? (
        <Box marginLeft={2}>
          <Text color={isError ? getColor('error') : getColor('text')}>{display}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────
export interface ToolResultMessageProps {
  result: ToolResultBlock;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ToolResultMessage({
  result,
}: ToolResultMessageProps): React.ReactElement {
  const custom = toolResultRegistry.get(result.toolName);
  if (custom) {
    return custom(result);
  }
  return <DefaultToolResultRenderer result={result} />;
}
