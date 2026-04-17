// Tabs.tsx — SPEC-840: Minimal tab group component.
// Accepts tabs: Array<{key, label, content}>, active index via useState.
// Tab switching via left/right arrow keys (Ink useInput).

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ThemedText } from './ThemedText.tsx';

export interface TabItem {
  key: string;
  label: string;
  content: React.ReactNode;
}

export interface TabsProps {
  tabs: TabItem[];
  /** Initial active tab index (default: 0) */
  initialIndex?: number;
}

export function Tabs({ tabs, initialIndex = 0 }: TabsProps): React.ReactElement {
  const [activeIndex, setActiveIndex] = useState(
    Math.min(initialIndex, Math.max(0, tabs.length - 1)),
  );

  useInput((_input, key) => {
    if (key.leftArrow) {
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : tabs.length - 1));
    } else if (key.rightArrow) {
      setActiveIndex((prev) => (prev < tabs.length - 1 ? prev + 1 : 0));
    }
  });

  const activeTab = tabs[activeIndex];

  return (
    <Box flexDirection="column">
      {/* Tab header row */}
      <Box flexDirection="row" marginBottom={1}>
        {tabs.map((tab, index) => {
          const isActive = index === activeIndex;
          return (
            <Box key={tab.key} marginRight={1} paddingX={1}>
              {isActive ? (
                <ThemedText token="claude" bold>
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
      {/* Active tab content */}
      <Box flexDirection="column">
        {activeTab !== undefined ? activeTab.content : null}
      </Box>
      {/* Navigation hint */}
      <Box marginTop={1}>
        <Text dimColor>← → navigate tabs</Text>
      </Box>
    </Box>
  );
}
