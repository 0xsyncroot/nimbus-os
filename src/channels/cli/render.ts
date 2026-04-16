// render.ts — SPEC-801: render loop outputs (chunks, tool events, spec announce) to stdout.
// v0.2.7: assistant text is buffered and rendered as styled ANSI Markdown on turn completion.
// v0.2.8: stream raw deltas to stdout immediately AND buffer for markdown re-render on message_stop.
//         plan_announce / spec_announce are suppressed from stdout (INTERNAL_PLAN block handles
//         model context; user doesn't need the pre-announcement echo).
// v0.3.2 (SPEC-826): friendly tool-event labels (VN/EN) + verbose escape hatch.

import type { LoopOutput } from '../../core/turn.ts';
import { logger } from '../../observability/logger.ts';
import { colors, prefixes, EARTH_DIM, EARTH_GOLD, RESET } from './colors.ts';
import { hasMarkdownSyntax, renderMarkdown } from './markdownRender.ts';
import { detectLocale, humanizeToolInvocation } from './toolLabels.ts';
import type { Locale } from './toolLabels.ts';
import { formatToolError } from './errorFormatCli.ts';

export interface RendererOutput {
  write(s: string): void;
  isTTY?: boolean;
}

export interface RendererOptions {
  /** If true, emit raw dev format: [TOOL] name, toolUseId, ms. Default: false. */
  verbose?: boolean;
  /** Locale for human labels. Defaults to detectLocale(). */
  locale?: Locale;
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
  opts: RendererOptions = {},
): Renderer {
  // Normalise: accept both legacy `(s: string) => void` and new `RendererOutput` object.
  // v0.3.3 fix — when called with a bare write fn (as repl.ts does), detect TTY
  // from process.stdout but also treat "TERM set and not dumb" as a TTY hint,
  // so Bun compiled binaries that under-report isTTY still re-render markdown.
  let output: RendererOutput;
  if (typeof writeOrOutput === 'function') {
    const stdoutTTY = process.stdout.isTTY === true;
    const termHint =
      process.env['TERM'] !== undefined &&
      process.env['TERM'] !== '' &&
      process.env['TERM'] !== 'dumb';
    const forceMarkdown = process.env['NIMBUS_FORCE_MARKDOWN'] === '1';
    output = { write: writeOrOutput, isTTY: forceMarkdown || stdoutTTY || termHint };
  } else {
    output = writeOrOutput;
  }

  const verbose = opts.verbose ?? process.env['NIMBUS_VERBOSE'] === '1';
  const locale: Locale = opts.locale ?? detectLocale();

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
          if (verbose) {
            output.write(`${colors.info(prefixes.tool)} ${ch.block.name}\n`);
          }
          // SPEC-826: friendly label emitted via tool_start event (loop layer); skip raw echo here.
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
      case 'tool_start': {
        flushAssistant();
        if (verbose) {
          output.write(`${colors.info(prefixes.tool)} \u2192 ${loopOutput.name} (${loopOutput.toolUseId})\n`);
        } else {
          const label = loopOutput.humanLabel ?? humanizeToolInvocation(loopOutput.name, loopOutput.args ?? {}, locale);
          // ⋯ (U+22EF) + dim style
          output.write(`  ${EARTH_DIM()}\u22EF ${RESET}đang ${label}\n`);
        }
        break;
      }
      case 'tool_end': {
        flushAssistant();
        if (verbose) {
          output.write(
            `${loopOutput.ok ? colors.ok(prefixes.ok) : colors.err(prefixes.err)} ${loopOutput.toolUseId} (${loopOutput.ms}ms)\n`,
          );
        } else if (loopOutput.ok) {
          const label = loopOutput.humanLabel ?? (locale === 'vi' ? 'xong' : 'done');
          // ✓ (U+2713) in gold
          output.write(`  ${EARTH_GOLD()}\u2713${RESET} ${label}\n`);
        } else {
          const errCode = loopOutput.errorCode ?? 'unknown';
          const friendly = formatToolError({ code: errCode, context: {} }, locale);
          // ✗ (U+2717) in red
          output.write(`  ${colors.err('\u2717')} ${friendly}\n`);
        }
        break;
      }
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
