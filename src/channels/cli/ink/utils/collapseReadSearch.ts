// collapseReadSearch.ts — SPEC-845: Pure coalesce algorithm for Read/Grep/Glob events.
// Groups consecutive read-only tool events into CoalescedGroup summaries.
// Break condition: any tool NOT in COLLAPSIBLE_TOOLS ends the current group.
// O(n) single-pass algorithm; no React, no side effects.

// ── Collapsible tool set ───────────────────────────────────────────────────────
export const COLLAPSIBLE_TOOLS = ['Read', 'Grep', 'Glob'] as const;
export type CollapsibleToolName = (typeof COLLAPSIBLE_TOOLS)[number];

function isCollapsible(name: string): name is CollapsibleToolName {
  return (COLLAPSIBLE_TOOLS as readonly string[]).includes(name);
}

// ── Event / group types ────────────────────────────────────────────────────────

export interface ToolEvent {
  toolName: string;
  args: Record<string, unknown>;
  result?: { matchCount?: number; lineCount?: number };
}

export interface CoalescedGroup {
  type: 'read-search';
  fileCount: number;
  searchTerms: string[];
  matchCount: number;
  events: ToolEvent[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractSearchTerm(event: ToolEvent): string | undefined {
  const { toolName, args } = event;
  if (toolName === 'Grep') {
    const pattern = args['pattern'] ?? args['query'] ?? args['term'];
    return typeof pattern === 'string' ? pattern : undefined;
  }
  if (toolName === 'Glob') {
    const p = args['pattern'];
    return typeof p === 'string' ? p : undefined;
  }
  return undefined;
}

function extractMatchCount(event: ToolEvent): number {
  return event.result?.matchCount ?? 0;
}

function buildGroup(events: ToolEvent[]): CoalescedGroup {
  let fileCount = 0;
  let matchCount = 0;
  const searchTerms: string[] = [];

  for (const ev of events) {
    if (ev.toolName === 'Read') {
      fileCount += 1;
    }
    if (ev.toolName === 'Glob') {
      // Glob lists files — treat each as a "file" result or count as 1 glob op
      fileCount += 1;
    }
    const term = extractSearchTerm(ev);
    if (term !== undefined && !searchTerms.includes(term)) {
      searchTerms.push(term);
    }
    matchCount += extractMatchCount(ev);
  }

  return { type: 'read-search', fileCount, searchTerms, matchCount, events };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * collapseReadSearch — coalesces consecutive Read/Grep/Glob tool events.
 *
 * Non-collapsible tools (Bash, Edit, Write, WebFetch, …) act as group
 * boundaries and are emitted as-is in the output array.
 *
 * Returns an array of CoalescedGroup (for read-search runs) or raw ToolEvent
 * (for everything else). Caller decides how to render each variant.
 */
export function collapseReadSearch(
  events: ToolEvent[],
): Array<CoalescedGroup | ToolEvent> {
  if (events.length === 0) return [];

  const output: Array<CoalescedGroup | ToolEvent> = [];
  let pending: ToolEvent[] = [];

  function flush(): void {
    if (pending.length === 0) return;
    output.push(buildGroup(pending));
    pending = [];
  }

  for (const ev of events) {
    if (isCollapsible(ev.toolName)) {
      pending.push(ev);
    } else {
      flush();
      output.push(ev);
    }
  }

  flush();
  return output;
}
