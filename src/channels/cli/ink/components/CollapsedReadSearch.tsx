// CollapsedReadSearch.tsx — SPEC-845: Single-line summary for coalesced Read/Grep/Glob events.
// Renders: "📖 Read 3 files, searched 'foo' → 12 matches" (en)
//          "📖 Đọc 3 tệp, tìm kiếm 'foo' → 12 kết quả"   (vi)
// noColor mode: strips emoji, uses text token only.
// Expand-on-e keybinding stubbed for v0.5.

import React from 'react';
import { Box, Text } from 'ink';
import type { CoalescedGroup } from '../utils/collapseReadSearch.ts';
import { useAppContext } from '../app.tsx';
import { useTheme } from '../theme.ts';

// ── Props ─────────────────────────────────────────────────────────────────────
export interface CollapsedReadSearchProps {
  group: CoalescedGroup;
}

// ── i18n helpers ─────────────────────────────────────────────────────────────

function pluralFile(n: number, locale: 'en' | 'vi'): string {
  if (locale === 'vi') return `${n} tệp`;
  return n === 1 ? '1 file' : `${n} files`;
}

function pluralMatch(n: number, locale: 'en' | 'vi'): string {
  if (locale === 'vi') return `${n} kết quả`;
  return n === 1 ? '1 match' : `${n} matches`;
}

function buildSummary(group: CoalescedGroup, locale: 'en' | 'vi'): string {
  const { fileCount, searchTerms, matchCount } = group;

  const filePart =
    locale === 'vi'
      ? `Đọc ${pluralFile(fileCount, locale)}`
      : `Read ${pluralFile(fileCount, locale)}`;

  if (searchTerms.length === 0) return filePart;

  const termList = searchTerms.map((t) => `'${t}'`).join(', ');
  const searchPart =
    locale === 'vi' ? `tìm kiếm ${termList}` : `searched ${termList}`;

  const matchPart = `→ ${pluralMatch(matchCount, locale)}`;

  return `${filePart}, ${searchPart} ${matchPart}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CollapsedReadSearch({
  group,
}: CollapsedReadSearchProps): React.ReactElement {
  const { locale, noColor } = useAppContext();
  const getColor = useTheme();

  const summary = buildSummary(group, locale);
  const icon = noColor ? '[R]' : '📖';

  return (
    <Box gap={1}>
      <Text color={noColor ? undefined : getColor('inactive')}>{icon}</Text>
      <Text color={noColor ? undefined : getColor('inactive')}>{summary}</Text>
      {/* Expand hint — keybinding e stubbed for v0.5 */}
      <Text color={noColor ? undefined : getColor('subtle')} dimColor={!noColor}>
        [e expand]
      </Text>
    </Box>
  );
}
