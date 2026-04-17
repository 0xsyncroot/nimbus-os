// commandSuggestions.ts — SPEC-842 T1: slash command match algorithm.
// Prefix-first, then fuzzy substring; mirrors Claude Code commandSuggestions.ts pattern.

import { listCommands, type SlashCommand } from '../../slashCommands.ts';

/**
 * Match commands against a query string.
 * - Empty query → returns all commands.
 * - Non-empty query → prefix-first, then fuzzy substring match.
 * - Results sorted: prefix matches before fuzzy, then alphabetically within each group.
 */
export function matchCommands(query: string): SlashCommand[] {
  const all = listCommands();
  if (query === '') return all;

  const q = query.toLowerCase();
  const prefix: SlashCommand[] = [];
  const fuzzy: SlashCommand[] = [];

  for (const cmd of all) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(q)) {
      prefix.push(cmd);
    } else if (name.includes(q)) {
      fuzzy.push(cmd);
    }
  }

  return [...prefix, ...fuzzy];
}

/**
 * Categories defined in the slash command registry (session/workspace/model/system).
 * Maps to display labels for the dropdown category headers.
 */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  session: 'Session',
  workspace: 'Workspace',
  model: 'Model',
  system: 'System',
  cost: 'Cost',
  memory: 'Memory',
  provider: 'Provider',
};

/**
 * Group commands by category, preserving order: session, workspace, model, system,
 * then any other categories alphabetically.
 */
export function groupByCategory(
  commands: SlashCommand[],
): Map<string, SlashCommand[]> {
  const ORDER = ['session', 'workspace', 'model', 'system'];
  const groups = new Map<string, SlashCommand[]>();

  for (const cmd of commands) {
    const cat = cmd.category ?? 'system';
    let group = groups.get(cat);
    if (!group) {
      group = [];
      groups.set(cat, group);
    }
    group.push(cmd);
  }

  // Re-order by priority
  const ordered = new Map<string, SlashCommand[]>();
  for (const cat of ORDER) {
    if (groups.has(cat)) {
      ordered.set(cat, groups.get(cat)!);
    }
  }
  // Append any remaining categories alphabetically
  for (const cat of [...groups.keys()].sort()) {
    if (!ordered.has(cat)) {
      ordered.set(cat, groups.get(cat)!);
    }
  }

  return ordered;
}
