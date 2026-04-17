// ModelPickerModal.tsx — SPEC-847 T2: /model picker with effort sidebar.
// Effort levels: none=○, low=◐, medium=●, high=◉.
// Left/right arrows cycle effort level; Enter commits selection.
// Mirrors Claude Code ModelPicker.tsx:39-447 pattern.

import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { AltScreen } from '../../altScreen.tsx';
import { ThemedText } from '../ThemedText.tsx';
import type { ModalProps } from './types.ts';

// ── Effort level types ─────────────────────────────────────────────────────────

export type EffortLevel = 'none' | 'low' | 'medium' | 'high';

const EFFORT_LEVELS: readonly EffortLevel[] = ['none', 'low', 'medium', 'high'];

const EFFORT_GLYPHS: Readonly<Record<EffortLevel, string>> = {
  none: '○',
  low: '◐',
  medium: '●',
  high: '◉',
};

const EFFORT_LABELS: Readonly<Record<EffortLevel, string>> = {
  none: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

// ── Props ──────────────────────────────────────────────────────────────────────

export interface ModelPickerModalProps extends ModalProps {
  models: string[];
  currentModel: string;
  onSelect: (model: string, effort: EffortLevel) => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ModelPickerModal({
  models,
  currentModel,
  onSelect,
  onClose,
}: ModelPickerModalProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  const initModelIdx = Math.max(0, models.indexOf(currentModel));
  const [modelIdx, setModelIdx] = useState(initModelIdx);
  const [effortIdx, setEffortIdx] = useState(0);

  useInput((_input, key) => {
    if (key.escape) { onClose(); return; }
    if (_input === 'q') { onClose(); return; }
    if (key.upArrow) {
      setModelIdx((prev) => (prev > 0 ? prev - 1 : models.length - 1));
      return;
    }
    if (key.downArrow) {
      setModelIdx((prev) => (prev < models.length - 1 ? prev + 1 : 0));
      return;
    }
    if (key.leftArrow) {
      setEffortIdx((prev) => (prev > 0 ? prev - 1 : EFFORT_LEVELS.length - 1));
      return;
    }
    if (key.rightArrow) {
      setEffortIdx((prev) => (prev < EFFORT_LEVELS.length - 1 ? prev + 1 : 0));
      return;
    }
    if (key.return) {
      const selectedModel = models[modelIdx];
      const selectedEffort = EFFORT_LEVELS[effortIdx];
      if (selectedModel !== undefined && selectedEffort !== undefined) {
        onSelect(selectedModel, selectedEffort);
      }
      onClose();
      return;
    }
  });

  const maxVisible = Math.max(1, rows - 6);
  const visible = models.slice(0, maxVisible);
  const effort = EFFORT_LEVELS[effortIdx] ?? 'none';

  return (
    <AltScreen>
      <Box flexDirection="column" width="100%" height={rows}>
        {/* Header */}
        <Box paddingX={2} paddingY={1} borderStyle="round" borderColor="gray">
          <ThemedText token="claude" bold>Model Picker</ThemedText>
          <Text> — effort: </Text>
          <ThemedText token="suggestion">{EFFORT_GLYPHS[effort]} {EFFORT_LABELS[effort]}</ThemedText>
        </Box>

        {/* Model list */}
        <Box flexDirection="column" flexGrow={1} paddingX={2}>
          {visible.map((model, idx) => {
            const isSelected = idx === modelIdx;
            return (
              <Box key={model} flexDirection="row">
                <Text>{isSelected ? '▶ ' : '  '}</Text>
                {isSelected ? (
                  <ThemedText token="claude" bold>{model}</ThemedText>
                ) : (
                  <ThemedText token="text">{model}</ThemedText>
                )}
              </Box>
            );
          })}
          {models.length > maxVisible && (
            <Box paddingX={2}>
              <Text dimColor>{`… ${models.length - maxVisible} more`}</Text>
            </Box>
          )}
        </Box>

        {/* Footer */}
        <Box paddingX={2}>
          <Text dimColor>↑↓ navigate  ← → effort  Enter select  Esc cancel</Text>
        </Box>
      </Box>
    </AltScreen>
  );
}
