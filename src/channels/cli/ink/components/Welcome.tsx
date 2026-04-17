// Welcome.tsx — SPEC-853: Ink-native welcome banner.
// 3 variants selected via cols + freshSession + noColor:
//   Wide    (cols≥70, freshSession=false): ASCII banner + version + hint
//   Compact (cols<70 OR freshSession=true): 3-line abbreviated panel
//   Plain   (noColor=true OR cols<40): single-line fallback

import React from 'react';
import { Box, Text } from 'ink';
import { ThemedText } from './ThemedText.tsx';

// ── Constants ──────────────────────────────────────────────────────────────────

/** 5-line ASCII banner — stored as constant, no font lib dep. Max 68 visible cols. */
const BANNER_WIDE = [
  ' ███╗   ██╗██╗███╗   ███╗██████╗ ██╗   ██╗███████╗',
  ' ████╗  ██║██║████╗ ████║██╔══██╗██║   ██║██╔════╝',
  ' ██╔██╗ ██║██║██╔████╔██║██████╔╝██║   ██║███████╗',
  ' ██║╚██╗██║██║██║╚██╔╝██║██╔══██╗██║   ██║╚════██║',
  ' ██║ ╚████║██║██║ ╚═╝ ██║██████╔╝╚██████╔╝███████║',
  ' ╚═╝  ╚═══╝╚═╝╚═╝     ╚═╝╚═════╝  ╚═════╝ ╚══════╝',
];

const HINT = 'What can I help with today?';
const ACCENT = '│';

// ── Freshness helper ───────────────────────────────────────────────────────────

/** Returns true if the previous session ended <5 minutes ago. */
export function isFreshSession(lastBootAt: number | undefined): boolean {
  if (!lastBootAt) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - lastBootAt < 300;
}

// ── Props ──────────────────────────────────────────────────────────────────────

export interface WelcomeProps {
  version: string;
  /** True if previous session ended <5 minutes ago — triggers compact variant */
  freshSession: boolean;
  noColor: boolean;
  cols: number;
  /** Workspace name to display */
  workspace?: string;
  /** Active model identifier */
  model?: string;
  /** Pre-flight hint: shown when defaultProvider has no resolvable key */
  keyHint?: string;
}

// ── Variant selector ───────────────────────────────────────────────────────────

type WelcomeVariant = 'wide' | 'compact' | 'plain';

function pickVariant(props: WelcomeProps): WelcomeVariant {
  if (props.noColor || props.cols < 40) return 'plain';
  if (props.cols >= 70 && !props.freshSession) return 'wide';
  return 'compact';
}

// ── Wide variant ───────────────────────────────────────────────────────────────

function WideWelcome({ version, workspace, model }: WelcomeProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {BANNER_WIDE.map((line, i) => (
        <ThemedText key={i} token="claude" bold>
          {line}
        </ThemedText>
      ))}
      <Box marginTop={1} gap={2}>
        <ThemedText token="inactive">{`v${version}`}</ThemedText>
        {workspace && (
          <ThemedText token="subtle">{`workspace: ${workspace}`}</ThemedText>
        )}
        {model && (
          <ThemedText token="subtle">{`model: ${model}`}</ThemedText>
        )}
      </Box>
      <ThemedText token="text">{HINT}</ThemedText>
    </Box>
  );
}

// ── Compact variant ────────────────────────────────────────────────────────────

function CompactWelcome({ version, workspace, model }: WelcomeProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <ThemedText token="claude">{ACCENT}</ThemedText>
        <ThemedText token="claude" bold>nimbus</ThemedText>
        <ThemedText token="inactive">{`v${version}`}</ThemedText>
      </Box>
      {(workspace ?? model) && (
        <Box gap={1}>
          <ThemedText token="subtle">{ACCENT}</ThemedText>
          {workspace && <ThemedText token="subtle">{workspace}</ThemedText>}
          {model && <ThemedText token="inactive">{model}</ThemedText>}
        </Box>
      )}
      <Box gap={1}>
        <ThemedText token="subtle">{ACCENT}</ThemedText>
        <ThemedText token="inactive">{HINT}</ThemedText>
      </Box>
    </Box>
  );
}

// ── Plain fallback ─────────────────────────────────────────────────────────────

function PlainWelcome({ version, workspace, model }: WelcomeProps): React.ReactElement {
  const wsLabel = workspace ? ` "${workspace}"` : '';
  const modelLabel = model ? ` (${model})` : '';
  return (
    <Text>{`[OK] nimbus v${version} ready — workspace${wsLabel}${modelLabel}`}</Text>
  );
}

// ── Public component ───────────────────────────────────────────────────────────

export function Welcome(props: WelcomeProps): React.ReactElement {
  const variant = pickVariant(props);
  const banner = variant === 'wide'
    ? <WideWelcome {...props} />
    : variant === 'compact'
      ? <CompactWelcome {...props} />
      : <PlainWelcome {...props} />;

  if (!props.keyHint) return banner;

  return (
    <Box flexDirection="column">
      {banner}
      <Box>
        <Text dimColor>{'⚠ '}</Text>
        <Text color="yellow">{props.keyHint}</Text>
      </Box>
    </Box>
  );
}
