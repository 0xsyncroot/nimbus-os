// BashPermissionRequest.tsx — SPEC-846: permission dialog for Bash tool.
// Shows command + getSimpleCommandPrefix() extraction.
// Destructive warning for rm/sudo/dd/mkfs/fork-bomb patterns via bashSecurity.ts tier-1.
// Prefix safety: if cmd contains ; && || | \n $( backtick → hide "Always" option (META-009 T23).

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme.ts';
import { checkBashCommand } from '../../../../../permissions/bashSecurity.ts';
import { PermissionDialog } from './PermissionDialog.tsx';
import type { PermissionDialogProps } from './PermissionDialog.tsx';
import { stripAnsiOsc } from '../StructuredDiff/colorDiff.ts';

// ── Compound-operator regex (META-009 T23) ─────────────────────────────────────
const COMPOUND_RE = /;|&&|\|\||[|]|\n|\$\(|`/;

// ── Extract simple command prefix ─────────────────────────────────────────────
// Returns the base command (first word) if the command is safe/simple.
// Returns null if compound operators are detected (prefix is ambiguous/unsafe).
export function getSimpleCommandPrefix(cmd: string): string | null {
  if (COMPOUND_RE.test(cmd)) return null;
  const first = cmd.trim().split(/\s+/)[0] ?? '';
  if (first.length === 0) return null;
  // Strip any leading path separator to get base name
  const base = first.split('/').pop() ?? first;
  return base;
}

// ── Destructive flag detection ─────────────────────────────────────────────────
// Uses tier-1 patterns from bashSecurity.ts. Returns the blocking reason string or null.
function getDestructiveWarning(cmd: string): string | null {
  const result = checkBashCommand(cmd);
  if (!result.ok && result.reason) {
    return result.reason;
  }
  return null;
}

// ── Component ──────────────────────────────────────────────────────────────────
export function BashPermissionRequest(props: PermissionDialogProps): React.ReactElement {
  const { toolInput, onAllow, onAlways, onDeny } = props;
  const getColor = useTheme();
  const warnColor = getColor('warning');
  const errorColor = getColor('error');
  const inactiveColor = getColor('inactive');

  const cmd = typeof toolInput['command'] === 'string' ? stripAnsiOsc(toolInput['command']) : '';
  const prefix = getSimpleCommandPrefix(cmd);
  const isCompound = COMPOUND_RE.test(cmd);
  const destructiveWarning = getDestructiveWarning(cmd);

  // If compound operators present → hide "Always" (allowAlways=false per META-009 T23)
  const allowAlways = !isCompound && prefix !== null;

  // Build "Always" label using prefix (or fall back to tool name)
  const alwaysLabelTarget = prefix ?? props.toolName;

  return (
    <PermissionDialog
      {...props}
      toolName={alwaysLabelTarget}
      allowAlways={allowAlways}
      onAllow={onAllow}
      onAlways={onAlways}
      onDeny={onDeny}
    >
      <Box flexDirection="column" gap={0}>
        {/* Command display */}
        <Box flexDirection="row">
          <Text color={inactiveColor !== '' ? inactiveColor : undefined} dimColor>
            {'$ '}
          </Text>
          <Text>{cmd}</Text>
        </Box>

        {/* Prefix info */}
        {prefix !== null && (
          <Text color={inactiveColor !== '' ? inactiveColor : undefined} dimColor>
            {`Command prefix: ${prefix}`}
          </Text>
        )}

        {/* Compound-operator security warning */}
        {isCompound && (
          <Box marginTop={1}>
            <Text color={warnColor !== '' ? warnColor : undefined}>
              {'⚠ Compound operators detected — per-invocation approval required'}
            </Text>
          </Box>
        )}

        {/* Destructive-command warning */}
        {destructiveWarning !== null && (
          <Box marginTop={1}>
            <Text color={errorColor !== '' ? errorColor : undefined} bold>
              {'⚠ Destructive command detected: '}
              <Text>{destructiveWarning}</Text>
            </Text>
          </Box>
        )}
      </Box>
    </PermissionDialog>
  );
}
