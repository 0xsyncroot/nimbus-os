// HelpOverlay.tsx — SPEC-842 T2: 3-tab /help overlay (Commands / General / Keybindings).
// Reachable via /help command OR '?' key synonym (SPEC-849 will own key registry;
// here we accept an `open` prop managed by parent). Half-height: maxHeight = rows/2.
// Mirrors Claude Code HelpV2.tsx:20-183 pattern. Tabs via SPEC-840 <Tabs>.

import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { ThemedText } from './ThemedText.tsx';
import { listCommands } from '../../slashCommands.ts';

// ── Props ────────────────────────────────────────────────────────────────────

export interface HelpOverlayProps {
  /** Called when user presses Esc or 'q' to close overlay. */
  onClose: () => void;
}

// ── Tab definitions ──────────────────────────────────────────────────────────

type TabKey = 'commands' | 'general' | 'keybindings';

interface Tab {
  key: TabKey;
  label: string;
}

const TABS: readonly Tab[] = [
  { key: 'commands', label: 'Commands' },
  { key: 'general', label: 'General' },
  { key: 'keybindings', label: 'Keybindings' },
];

// ── Keybinding table ──────────────────────────────────────────────────────────

const KEYBINDING_ROWS: readonly [string, string][] = [
  ['Enter', 'Submit prompt'],
  ['Shift+Enter', 'Insert newline (multi-line)'],
  ['↑ / ↓', 'Navigate history / dropdown'],
  ['Tab', 'Accept autocomplete suggestion'],
  ['Esc', 'Dismiss overlay / clear mode'],
  ['Shift+Tab', 'Cycle input mode'],
  ['Ctrl+C', 'Cancel turn / exit (double)'],
  ['Ctrl+L', 'Clear input buffer'],
  ['?', 'Open this help overlay'],
  ['/', 'Open slash command autocomplete'],
  ['@', 'Open file-ref autocomplete'],
  ['← →', 'Navigate help tabs'],
];

// ── General info ──────────────────────────────────────────────────────────────

const GENERAL_LINES: readonly string[] = [
  'nimbus-os — personal AI OS with persistent memory and identity.',
  '',
  'Input Modes:',
  '  text      — default text input',
  '  slash (/) — slash command mode',
  '  file-ref (@) — attach workspace files',
  '  bash (!)  — shell command passthrough',
  '  memory (#) — memory query mode',
  '',
  'Workspaces store SOUL.md, MEMORY.md, and session history.',
  'Run /soul or /memory to inspect workspace context.',
  '',
  'Use /cost to see session token cost.',
  'Use /model to switch models interactively.',
];

// ── Sub-renders ───────────────────────────────────────────────────────────────

function CommandsTab({ maxRows }: { maxRows: number }): React.ReactElement {
  const cmds = listCommands();
  const visible = cmds.slice(0, maxRows);
  return (
    <Box flexDirection="column">
      {visible.map((cmd) => (
        <Box key={cmd.name} paddingX={1}>
          <ThemedText token="claude">
            {`/${cmd.name}`.padEnd(18)}
          </ThemedText>
          <ThemedText token="inactive">
            {cmd.description}
          </ThemedText>
        </Box>
      ))}
      {cmds.length > maxRows && (
        <Box paddingX={1}>
          <Text dimColor>{`… ${cmds.length - maxRows} more`}</Text>
        </Box>
      )}
    </Box>
  );
}

function GeneralTab({ maxRows }: { maxRows: number }): React.ReactElement {
  const lines = GENERAL_LINES.slice(0, maxRows);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i} paddingX={1}>
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

function KeybindingsTab({ maxRows }: { maxRows: number }): React.ReactElement {
  const visible = KEYBINDING_ROWS.slice(0, maxRows);
  return (
    <Box flexDirection="column">
      {visible.map(([key, desc]) => (
        <Box key={key} paddingX={1}>
          <ThemedText token="suggestion">
            {key.padEnd(20)}
          </ThemedText>
          <ThemedText token="inactive">
            {desc}
          </ThemedText>
        </Box>
      ))}
    </Box>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function HelpOverlay({ onClose }: HelpOverlayProps): React.ReactElement {
  const [activeIdx, setActiveIdx] = useState(0);
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  // Half-height — match Claude Code HelpV2:30 pattern
  const maxHeight = Math.floor(rows / 2);
  // Reserve rows for: border(2) + tab header(1) + footer(2) = 5
  const contentRows = Math.max(1, maxHeight - 5);

  const activeTab = TABS[activeIdx];

  useInput((_input, key) => {
    if (key.leftArrow) {
      setActiveIdx((prev) => (prev > 0 ? prev - 1 : TABS.length - 1));
      return;
    }
    if (key.rightArrow) {
      setActiveIdx((prev) => (prev < TABS.length - 1 ? prev + 1 : 0));
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
    // 'q' closes overlay
    if (_input === 'q') {
      onClose();
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      width="100%"
    >
      {/* Tab header */}
      <Box flexDirection="row" paddingX={1} marginBottom={0}>
        {TABS.map((tab, idx) => {
          const isActive = idx === activeIdx;
          return (
            <Box key={tab.key} marginRight={2} paddingX={1}>
              {isActive ? (
                <ThemedText token="claude" bold underline>
                  {tab.label}
                </ThemedText>
              ) : (
                <ThemedText token="inactive">
                  {tab.label}
                </ThemedText>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Divider */}
      <Box paddingX={1}>
        <Text dimColor>{'─'.repeat(60)}</Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column" height={contentRows}>
        {activeTab?.key === 'commands' && <CommandsTab maxRows={contentRows} />}
        {activeTab?.key === 'general' && <GeneralTab maxRows={contentRows} />}
        {activeTab?.key === 'keybindings' && <KeybindingsTab maxRows={contentRows} />}
      </Box>

      {/* Footer */}
      <Box paddingX={1} marginTop={0}>
        <Text dimColor>← → navigate tabs  Esc / q close</Text>
      </Box>
    </Box>
  );
}
