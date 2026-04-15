#!/usr/bin/env bun
// scripts/spec/index.ts — Internal SDD dev tooling entry
// NOT a user-facing nimbus command. For developers building nimbus-os.
// Run via: bun run spec <subcommand>

import { runSpecCommand } from './cli.ts';

const args = process.argv.slice(2);

runSpecCommand(args)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(3);
  });
