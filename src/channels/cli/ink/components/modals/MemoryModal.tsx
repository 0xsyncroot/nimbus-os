// MemoryModal.tsx — SPEC-847 T3: /memory browser with pagination.
// ANSI-OSC strip MANDATORY (META-009 T22) — file content MUST be sanitised
// via stripAnsiOsc before render; fixture \x1b[2J must NOT wipe terminal.
// Pagination: PageUp / PageDown navigate when content exceeds rows.

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { AltScreen } from '../../altScreen.tsx';
import { ThemedText } from '../ThemedText.tsx';
import { stripAnsiOsc } from '../Markdown.tsx';
import { workspacePaths } from '../../../../../core/workspaceMemory.ts';
import type { ModalProps } from './types.ts';

// ── Props ──────────────────────────────────────────────────────────────────────

export interface MemoryModalProps extends ModalProps {
  workspaceId: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function MemoryModal({ workspaceId, onClose }: MemoryModalProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const pageSize = Math.max(1, rows - 4); // reserve header + footer rows

  const [lines, setLines] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const paths = workspacePaths(workspaceId);
    void Bun.file(paths.memoryMd)
      .text()
      .then((raw) => {
        // ANSI-OSC strip — prevents escape sequences in MEMORY.md from affecting terminal
        const safe = stripAnsiOsc(raw);
        setLines(safe.split('\n'));
      })
      .catch((err: unknown) => {
        setError((err as Error).message ?? 'Could not read MEMORY.md');
      });
  }, [workspaceId]);

  const totalPages = Math.max(1, Math.ceil(lines.length / pageSize));

  useInput((_input, key) => {
    if (key.escape || _input === 'q') { onClose(); return; }
    if (key.pageUp) {
      setPage((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.pageDown) {
      setPage((prev) => Math.min(totalPages - 1, prev + 1));
      return;
    }
  });

  const pageLines = lines.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <AltScreen>
      <Box flexDirection="column" width="100%" height={rows}>
        {/* Header */}
        <Box paddingX={2} paddingY={1}>
          <ThemedText token="claude" bold>Memory</ThemedText>
          <Text dimColor>{` — MEMORY.md  (page ${page + 1}/${totalPages})`}</Text>
        </Box>

        {/* Content */}
        <Box flexDirection="column" flexGrow={1} paddingX={2} overflowY="hidden">
          {error !== null ? (
            <Text color="red">{error}</Text>
          ) : (
            pageLines.map((line, i) => (
              <Text key={`${page}-${i}`}>{line}</Text>
            ))
          )}
        </Box>

        {/* Footer */}
        <Box paddingX={2}>
          <Text dimColor>PageUp / PageDown navigate  Esc / q close</Text>
        </Box>
      </Box>
    </AltScreen>
  );
}
