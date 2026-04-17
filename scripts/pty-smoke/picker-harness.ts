#!/usr/bin/env bun
// picker-harness.ts — tiny Bun entrypoint that runs confirmPick / pickOne
// against the REAL process.stdin/stdout so we can smoke-test it under a
// genuine PTY (via `expect`). Prints the resolved value on stdout terminated
// by `<<RESULT>>` markers so the expect script can parse it deterministically.
//
// Usage:
//   bun run scripts/pty-smoke/picker-harness.ts confirm
//   bun run scripts/pty-smoke/picker-harness.ts pick
//
// Meant to be driven by tests/onboard/pty.smoke.expect (expect(1) script) or
// node-pty. Never shipped to users.

import { confirmPick, pickOne } from '../../src/onboard/picker.ts';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'confirm';
  if (mode === 'confirm') {
    const result = await confirmPick('Do it?');
    process.stdout.write(`\n<<RESULT:${result}>>\n`);
  } else if (mode === 'pick') {
    const result = await pickOne(
      'Pick fruit',
      [
        { value: 'apple', label: 'Apple' },
        { value: 'banana', label: 'Banana' },
        { value: 'cherry', label: 'Cherry' },
      ],
      { default: 0 },
    );
    process.stdout.write(`\n<<RESULT:${JSON.stringify(result)}>>\n`);
  } else {
    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exit(2);
  }
  process.exit(0);
}

await main();
