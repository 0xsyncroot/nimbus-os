#!/usr/bin/env bun
// repl-repro-full.ts — closer mirror of the real REPL flow under PTY.
//
// Compared to repl-repro.ts, this one includes:
//  - Streaming renderer writes to stdout during "fake turn" (mimics LLM streaming)
//  - Simulated tool-invocation dispatch via onAsk callback (the real code path)
//  - Exercises the SAME makeOnAsk() helper from repl.ts (not just confirmPick)
//
// Goal: catch any interference that the renderer or the LLM turn introduces
// between user Enter and picker opening.

import { createInterface } from 'node:readline';
import readline from 'node:readline';
import { createAutocomplete, type AutocompleteInput } from '../../src/channels/cli/slashAutocomplete.ts';
import { makeOnAsk } from '../../src/channels/cli/repl.ts';
import type { ToolInvocation as LoopToolInvocation } from '../../src/core/loop.ts';

// Global trace: see every byte + every keypress.
// Controlled via REPRO_GLOBAL_TRACE=1 so we can remove global listeners to
// test whether THEY were masking the bug (emitKeypressEvents attached from
// this test setup consuming bytes that would otherwise reach the picker).
const globalInput = process.stdin;
if (process.env['REPRO_GLOBAL_TRACE'] === '1') {
  readline.emitKeypressEvents(globalInput);
  globalInput.on('keypress', (str, key) => {
    if (process.env['NIMBUS_PICKER_TRACE'] === '1') {
      process.stderr.write(`[global-keypress] name=${key?.name ?? '?'} seq=${JSON.stringify(key?.sequence ?? str ?? '')} time=${Date.now() % 100000}\n`);
    }
  });
  globalInput.on('data', (chunk: string | Buffer) => {
    if (process.env['NIMBUS_PICKER_TRACE'] === '1') {
      const hex = Buffer.isBuffer(chunk) ? chunk.toString('hex') : Buffer.from(chunk, 'utf8').toString('hex');
      process.stderr.write(`[global-data] hex=${hex} time=${Date.now() % 100000}\n`);
    }
  });
}

async function main(): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;

  const rl = createInterface({ input, output, terminal: true });

  const ttyInput = input as AutocompleteInput;
  const ac = createAutocomplete({
    input: ttyInput,
    output,
    promptStr: () => 'nimbus > ',
    commands: () => [],
    cols: () => 80,
  });

  process.stderr.write(`[repro-debug] about to readLine\n`);
  const line = await ac.readLine();
  process.stderr.write(`[repro-debug] readLine returned: ${JSON.stringify(line)}\n`);

  // Simulate an LLM streaming response for some time (matches real flow)
  const streamMs = Number(process.env['REPRO_STREAM_MS'] ?? '800');
  const start = Date.now();
  output.write('\n');
  while (Date.now() - start < streamMs) {
    output.write('.');
    await new Promise((r) => setTimeout(r, 50));
  }
  output.write('\n');

  // CRUCIAL: pause stdin so any bytes sent during the "streaming" phase
  // accumulate in the stream's internal buffer. This matches what happens
  // in the real REPL between autocomplete cleanup and picker attach.
  if (process.env['REPRO_PAUSE_BEFORE_PICKER'] === '1') {
    (input as { pause?: () => void }).pause?.();
    process.stderr.write(`[repro-debug] input paused; waiting 300ms for buffered bytes\n`);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Now invoke makeOnAsk — the REAL code path from repl.ts
  process.stderr.write(`[repro-debug] about to call makeOnAsk→confirmPick\n`);
  const onAsk = makeOnAsk(input, output, true);
  if (!onAsk) {
    process.stderr.write(`[repro-debug] onAsk is undefined (not TTY?)\n`);
    process.exit(3);
  }
  const fakeInv: LoopToolInvocation = {
    toolUseId: 'fake-1',
    name: 'TelegramStatus',
    input: {},
  };
  const decision = await onAsk(fakeInv);
  process.stderr.write(`[repro-debug] onAsk returned: ${decision}\n`);

  output.write(`\n<<RESULT:${decision}>>\n`);
  ac.dispose();
  rl.close();
  process.exit(0);
}

await main();
