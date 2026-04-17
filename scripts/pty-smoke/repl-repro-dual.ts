#!/usr/bin/env bun
// repl-repro-dual.ts — exercise TWO consecutive pickers in a single REPL
// "turn". Simulates the user's Screenshot B scenario where the same bug
// repeated on a second confirm after a first.

import { createInterface } from 'node:readline';
import { createAutocomplete, type AutocompleteInput } from '../../src/channels/cli/slashAutocomplete.ts';
import { makeOnAsk } from '../../src/channels/cli/repl.ts';
import type { ToolInvocation as LoopToolInvocation } from '../../src/core/loop.ts';

async function main(): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;
  const rl = createInterface({ input, output, terminal: true });
  const ac = createAutocomplete({
    input: input as AutocompleteInput,
    output,
    promptStr: () => 'nimbus > ',
    commands: () => [],
    cols: () => 80,
  });

  const line = await ac.readLine();
  process.stderr.write(`[repro-debug] line=${JSON.stringify(line)}\n`);

  // Stream some output (mock LLM)
  output.write('\n');
  for (let i = 0; i < 6; i++) {
    output.write('.');
    await new Promise((r) => setTimeout(r, 50));
  }
  output.write('\n');

  const onAsk = makeOnAsk(input, output, true)!;

  // First picker
  const decision1 = await onAsk({ toolUseId: 't1', name: 'TelegramStatus', input: {} } as LoopToolInvocation);
  output.write(`\n[decision1]=${decision1}\n`);

  // Stream a tiny bit more (simulates agent continuing after first tool)
  for (let i = 0; i < 3; i++) {
    output.write('.');
    await new Promise((r) => setTimeout(r, 50));
  }
  output.write('\n');

  // Second picker
  const decision2 = await onAsk({ toolUseId: 't2', name: 'TelegramStatus', input: {} } as LoopToolInvocation);
  output.write(`\n<<RESULT:${decision1}+${decision2}>>\n`);
  ac.dispose();
  rl.close();
  process.exit(0);
}

await main();
