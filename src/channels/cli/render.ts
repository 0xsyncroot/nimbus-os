// render.ts — SPEC-801: render loop outputs (chunks, tool events, spec announce) to stdout.
// v0.2.7: assistant text is buffered and rendered as styled ANSI Markdown on turn completion.
// v0.2.8: stream raw deltas to stdout immediately AND buffer for markdown re-render on message_stop.
//         plan_announce / spec_announce are suppressed from stdout (INTERNAL_PLAN block handles
//         model context; user doesn't need the pre-announcement echo).

import type { LoopOutput } from '../../core/turn.ts';
import { logger } from '../../observability/logger.ts';
import { colors, prefixes } from './colors.ts';
import { hasMarkdownSyntax, renderMarkdown } from './markdownRender.ts';

export interface RendererOutput {
  write(s: string): void;
  isTTY?: boolean;
}

export interface Renderer {
  handle(output: LoopOutput): void;
  flush(): void;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function countNewlines(s: string): number {
  let count = 0;
  for (const ch of s) if (ch === '\n') count++;
  return count;
}

// ── factory ───────────────────────────────────────────────────────────────────

export function createRenderer(
  writeOrOutput: ((s: string) => void) | RendererOutput = process.stdout,
): Renderer {
  // Normalise: accept both legacy `(s: string) => void` and new `RendererOutput` object.
  let output: RendererOutput;
  if (typeof writeOrOutput === 'function') {
    output = { write: writeOrOutput, isTTY: process.stdout.isTTY };
  } else {
    output = writeOrOutput;
  }

  // assistantBuf accumulates streaming text deltas; flushed + re-rendered on message_stop / turn_end.
  let assistantBuf = '';
  // streamedLineCount tracks how many newlines were streamed raw so we can cursor-up to erase them.
  let streamedLineCount = 0;

  function flushAssistant(): void {
    if (!assistantBuf) return;
    if (hasMarkdownSyntax(assistantBuf) && output.isTTY) {
      // Cursor-up the streamed lines + clear, then re-emit with markdown.
      if (streamedLineCount > 0) {
        output.write(`\x1b[${streamedLineCount}F\x1b[J`);
      }
      output.write(renderMarkdown(assistantBuf));
      if (!assistantBuf.endsWith('\n')) output.write('\n');
    } else {
      // Non-markdown or non-TTY: just ensure trailing newline.
      if (!assistantBuf.endsWith('\n')) output.write('\n');
    }
    assistantBuf = '';
    streamedLineCount = 0;
  }

  function handle(loopOutput: LoopOutput): void {
    switch (loopOutput.kind) {
      case 'chunk': {
        const ch = loopOutput.chunk;
        if (ch.type === 'content_block_delta' && ch.delta.type === 'text') {
          // v0.2.8: stream raw AND buffer
          const text = (ch.delta as { type: 'text'; text?: string }).text ?? '';
          output.write(text);
          streamedLineCount += countNewlines(text);
          assistantBuf += text;
        } else if (ch.type === 'content_block_start' && ch.block.type === 'tool_use') {
          flushAssistant();
          output.write(`${colors.info(prefixes.tool)} ${ch.block.name}\n`);
        } else if (ch.type === 'message_stop') {
          flushAssistant();
        }
        break;
      }
      case 'plan_announce':
        // v0.2.8: plan stays INTERNAL — visible only in model context via
        // [INTERNAL_PLAN] system prompt block. No stdout echo.
        logger.debug({ reason: loopOutput.reason.slice(0, 200) }, 'plan_generated');
        break;
      case 'spec_announce':
        // v0.2.8: spec summary is INTERNAL — no stdout echo.
        logger.debug({ summary: loopOutput.summary.slice(0, 200) }, 'plan_generated');
        break;
      case 'tool_start':
        flushAssistant();
        output.write(`${colors.info(prefixes.tool)} → ${loopOutput.name}\n`);
        break;
      case 'tool_end':
        flushAssistant();
        output.write(
          `${loopOutput.ok ? colors.ok(prefixes.ok) : colors.err(prefixes.err)} ${loopOutput.toolUseId} (${loopOutput.ms}ms)\n`,
        );
        break;
      case 'turn_end':
        flushAssistant();
        if (loopOutput.metric.outcome === 'cancelled') {
          output.write(`${colors.warn(prefixes.warn)} turn cancelled\n`);
        } else if (loopOutput.metric.outcome === 'error') {
          output.write(
            `${colors.err(prefixes.err)} turn failed: ${loopOutput.metric.errorCode ?? 'unknown'}\n`,
          );
        }
        break;
    }
  }

  return {
    handle,
    flush: flushAssistant,
  };
}
