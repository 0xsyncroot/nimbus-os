// render.ts — SPEC-801: render loop outputs (chunks, tool events, spec announce) to stdout.

import type { LoopOutput } from '../../core/turn.ts';
import { colors, prefixes } from './colors.ts';

export interface Renderer {
  handle(output: LoopOutput): void;
  flush(): void;
}

export function createRenderer(write: (s: string) => void = (s) => process.stdout.write(s)): Renderer {
  let inAssistantText = false;

  function finalizeLine(): void {
    if (inAssistantText) {
      write('\n');
      inAssistantText = false;
    }
  }

  function handle(output: LoopOutput): void {
    switch (output.kind) {
      case 'chunk': {
        const ch = output.chunk;
        if (ch.type === 'content_block_delta' && ch.delta.type === 'text') {
          inAssistantText = true;
          write(ch.delta.text ?? '');
        } else if (ch.type === 'content_block_start' && ch.block.type === 'tool_use') {
          finalizeLine();
          write(`${colors.info(prefixes.tool)} ${ch.block.name}\n`);
        } else if (ch.type === 'message_stop') {
          finalizeLine();
        }
        break;
      }
      case 'plan_announce':
        finalizeLine();
        write(`${colors.dim(prefixes.plan)} ${output.reason}\n`);
        break;
      case 'spec_announce':
        finalizeLine();
        write(`${colors.dim(prefixes.spec)} ${output.summary}\n`);
        break;
      case 'tool_start':
        finalizeLine();
        write(`${colors.info(prefixes.tool)} → ${output.name}\n`);
        break;
      case 'tool_end':
        finalizeLine();
        write(
          `${output.ok ? colors.ok(prefixes.ok) : colors.err(prefixes.err)} ${output.toolUseId} (${output.ms}ms)\n`,
        );
        break;
      case 'turn_end':
        finalizeLine();
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
    flush: finalizeLine,
  };
}
