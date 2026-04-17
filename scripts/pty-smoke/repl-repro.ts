#!/usr/bin/env bun
// repl-repro.ts — reproduce the exact REPL → confirmPick sequence under PTY.
//
// Mirrors src/channels/cli/repl.ts:
//   1. createInterface({input, output, terminal:true})  ← readline attaches keypress
//   2. createAutocomplete({input,...})  ← attaches 'data' listener
//   3. ac.readLine() → user types message + Enter
//   4. runSingleTurn → makeOnAsk → confirmPick
//
// We simulate a fake "turn" that immediately fires the confirm picker, so we
// don't need a real LLM. Prints <<RESULT:...>> for expect.

import { createInterface } from 'node:readline';
import readline from 'node:readline';
import { createAutocomplete, type AutocompleteInput } from '../../src/channels/cli/slashAutocomplete.ts';
import { confirmPick } from '../../src/onboard/picker.ts';

// Global keypress listener BEFORE anything else — to see every keypress event
// emitted at any point.
const globalInput = process.stdin;
readline.emitKeypressEvents(globalInput);
globalInput.on('keypress', (str, key) => {
  if (process.env['NIMBUS_PICKER_TRACE'] === '1') {
    process.stderr.write(`[global-keypress] name=${key?.name ?? '?'} seq=${JSON.stringify(key?.sequence ?? str ?? '')} time=${Date.now() % 100000}\n`);
  }
});

// Also attach a RAW data listener to see every byte.
globalInput.on('data', (chunk: string | Buffer) => {
  if (process.env['NIMBUS_PICKER_TRACE'] === '1') {
    const hex = Buffer.isBuffer(chunk) ? chunk.toString('hex') : Buffer.from(chunk, 'utf8').toString('hex');
    process.stderr.write(`[global-data] hex=${hex} time=${Date.now() % 100000}\n`);
  }
});

async function main(): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;

  // Mirror repl.ts line 262
  const rl = createInterface({ input, output, terminal: true });

  // Mirror repl.ts line 281 — autocomplete in TTY
  const ttyInput = input as AutocompleteInput;
  const ac = createAutocomplete({
    input: ttyInput,
    output,
    promptStr: () => 'nimbus > ',
    commands: () => [],
    cols: () => 80,
  });

  // Phase 1: read one line (simulate user's REPL input)
  process.stderr.write(`[repro-debug] about to readLine\n`);
  const line = await ac.readLine();
  process.stderr.write(`[repro-debug] readLine returned: ${JSON.stringify(line)}\n`);
  output.write(`\n[repro] got line: ${JSON.stringify(line)}\n`);

  // Simulate LLM thinking time — so when picker opens, stdin has been
  // quiescent for a while. This matches the real user flow.
  const delayMs = Number(process.env['REPRO_DELAY_MS'] ?? '1500');
  await new Promise((r) => setTimeout(r, delayMs));

  // Phase 2: fire confirm picker
  process.stderr.write(`[repro-debug] about to call confirmPick\n`);
  const decision = await confirmPick('Do it?', { input, output });
  process.stderr.write(`[repro-debug] confirmPick returned: ${decision}\n`);

  output.write(`\n<<RESULT:${decision}>>\n`);
  ac.dispose();
  rl.close();
  process.exit(0);
}

await main();
