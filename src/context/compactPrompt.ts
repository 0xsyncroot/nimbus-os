// compactPrompt.ts — SPEC-120: 9-section summarisation prompt for context compaction.
// Based on Claude Code src/services/compact/prompt.ts (reverse-engineered pattern).
// Pure TS, no external deps.

/**
 * System prompt for the forked summarisation LLM call.
 * Stable prefix for Anthropic prompt caching — do NOT vary the system text per call.
 */
export const COMPACT_SYSTEM_PROMPT =
  `You are a precise context summariser. Your job is to produce a structured summary of a conversation that preserves all information required to continue the work seamlessly.

Output format (REQUIRED):
1. Start with <analysis> ... </analysis> — your chain-of-thought reasoning (will be stripped before insertion).
2. Then output <summary> ... </summary> containing the 9-section report below.

Rules:
- Be specific: use exact file paths, function names, error messages, and code snippets where relevant.
- Preserve user intent: capture WHY, not just WHAT.
- Do NOT omit pending tasks or partial work.
- Do NOT use tools or make API calls.
- Do NOT truncate the summary mid-section.`;

/** Format the conversation messages into the compact user prompt. */
export function formatCompactPrompt(conversationText: string): string {
  return `Please summarise the following conversation. Produce a 9-section <summary> covering:

1. **Primary Request and Intent** — The user's core goal and any clarifications. Quote the original ask verbatim if possible.
2. **Key Technical Concepts** — Languages, frameworks, libraries, patterns, protocols mentioned or used.
3. **Files and Code Sections** — All file paths read, written, or discussed. Include relevant snippets or line references.
4. **Errors and Fixes** — Every error message encountered and the fix applied (or attempted). Include stack traces if short.
5. **Problem Solving** — Approaches tried, decisions made, trade-offs discussed, and the reasoning behind them.
6. **All User Messages** — A verbatim or near-verbatim record of every user message that is NOT a tool result.
7. **Pending Tasks** — Any TODO, incomplete work, open questions, or blocked items the user mentioned.
8. **Current Work** — The exact state of the most recent task: what was being done when the conversation ends.
9. **Optional Next Step** — If obvious from context, one concrete recommended action to continue.

--- CONVERSATION START ---
${conversationText}
--- CONVERSATION END ---`;
}

/**
 * Extracts the <summary> block from a raw model response, stripping <analysis>.
 * Returns the summary text, or the entire response if no <summary> tags found.
 */
export function formatCompactSummary(raw: string): string {
  // Strip analysis block
  const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim();

  // Extract summary block
  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim();
  }

  // Fallback: return cleaned response (no summary tags — model may have not followed format)
  return withoutAnalysis;
}

/**
 * Checks that a summary string contains all 9 expected section headings.
 * Used in tests and optionally as a quality gate.
 */
export function validateSummarySections(summary: string): { ok: boolean; missing: string[] } {
  const expected = [
    'Primary Request and Intent',
    'Key Technical Concepts',
    'Files and Code Sections',
    'Errors and Fixes',
    'Problem Solving',
    'All User Messages',
    'Pending Tasks',
    'Current Work',
    'Optional Next Step',
  ];
  const missing = expected.filter((section) => !summary.includes(section));
  return { ok: missing.length === 0, missing };
}

/** Serialise CanonicalMessages to plain text for the compact prompt body. */
export function messagesToPlainText(
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; content?: string | unknown[] }> }>,
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const roleLabel = msg.role.toUpperCase();
    if (typeof msg.content === 'string') {
      lines.push(`[${roleLabel}]: ${msg.content}`);
    } else {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (block.type === 'tool_use') {
          parts.push(`[tool_use: ${(block as { name?: string }).name ?? 'unknown'}]`);
        } else if (block.type === 'tool_result') {
          const c = block.content;
          if (typeof c === 'string') parts.push(`[tool_result: ${c.slice(0, 200)}]`);
          else parts.push('[tool_result: ...]');
        } else if (block.type === 'thinking' && typeof block.text === 'string') {
          parts.push(`[thinking: ${block.text.slice(0, 100)}...]`);
        }
      }
      lines.push(`[${roleLabel}]: ${parts.join(' ')}`);
    }
  }
  return lines.join('\n\n');
}
