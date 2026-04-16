// render.ts — SPEC-801: render loop outputs (chunks, tool events, spec announce) to stdout.
// v0.2.7: assistant text is buffered and rendered as styled ANSI Markdown on turn completion.

import type { LoopOutput } from '../../core/turn.ts';
import { colors, prefixes } from './colors.ts';
import { renderMarkdown } from './markdownRender.ts';

export interface Renderer {
  handle(output: LoopOutput): void;
  flush(): void;
}

export function createRenderer(write: (s: string) => void = (s) => process.stdout.write(s)): Renderer {
  // assistantBuf accumulates streaming text deltas; flushed + rendered on message_stop / turn_end.
  let assistantBuf = '';

  function flushAssistant(): void {
    if (assistantBuf.length === 0) return;
    const rendered = renderMarkdown(assistantBuf);
    write(rendered);
    // Ensure output ends with newline for clean subsequent prefixes.
    if (!rendered.endsWith('\n')) write('\n');
    assistantBuf = '';
  }

  function handle(output: LoopOutput): void {
    switch (output.kind) {
      case 'chunk': {
        const ch = output.chunk;
        if (ch.type === 'content_block_delta' && ch.delta.type === 'text') {
          assistantBuf += ch.delta.text ?? '';
        } else if (ch.type === 'content_block_start' && ch.block.type === 'tool_use') {
          flushAssistant();
          write(`${colors.info(prefixes.tool)} ${ch.block.name}\n`);
        } else if (ch.type === 'message_stop') {
          flushAssistant();
        }
        break;
      }
      case 'plan_announce':
        flushAssistant();
        write(`${colors.dim(prefixes.plan)} ${output.reason}\n`);
        break;
      case 'spec_announce':
        flushAssistant();
        // SPEC-110 v2: 1-line FYI using [plan] prefix. Full view: /spec-show (TODO).
        write(`${colors.dim(prefixes.plan)} ${output.summary}\n`);
        break;
      case 'tool_start':
        flushAssistant();
        write(`${colors.info(prefixes.tool)} → ${output.name}\n`);
        break;
      case 'tool_end':
        flushAssistant();
        write(
          `${output.ok ? colors.ok(prefixes.ok) : colors.err(prefixes.err)} ${output.toolUseId} (${output.ms}ms)\n`,
        );
        break;
      case 'turn_end':
        flushAssistant();
        if (output.metric.outcome === 'cancelled') {
          write(`${colors.warn(prefixes.warn)} turn cancelled\n`);
        } else if (output.metric.outcome === 'error') {
          write(`${colors.err(prefixes.err)} turn failed: ${output.metric.errorCode ?? 'unknown'}\n`);
        }
        break;
    }
  }

  return {
    handle,
    flush: flushAssistant,
  };
}
