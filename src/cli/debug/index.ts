// index.ts — `nimbus debug <verb>` dispatcher (SPEC-828)
// Routes power-user / diagnostic verbs that are hidden from the main help screen.

function printDebugHelp(): void {
  process.stdout.write(`nimbus debug — diagnostic tools

Usage:
  nimbus debug doctor                  Health check — platform, vault, permissions
  nimbus debug status [--json]         1-line overview: OK | last error | today cost
  nimbus debug health [--json]         Subsystem health + memory + disk
  nimbus debug metrics [--since 1h|1d] p50/p95/p99 latency + tokens + cost  [--json]
  nimbus debug errors [--since] [--code X_*]  Error counts by code  [--json]
  nimbus debug trace <turnId> [--json] Turn event tree
  nimbus debug audit [--since] [--severity]   Security events + exec/write log  [--json]
  nimbus debug vault <sub>             Manage encrypted secrets vault
                                         sub: reset [--yes]  status

Run \`nimbus debug <verb> --help\` for per-verb flags.
`);
}

export async function runDebug(argv: readonly string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1) as string[];

  switch (sub) {
    case 'doctor': {
      const { runDoctor } = await import('./doctor.ts');
      return runDoctor();
    }
    case 'status': {
      const { runStatus } = await import('./status.ts');
      return runStatus(rest);
    }
    case 'health': {
      const { runHealth } = await import('./health.ts');
      return runHealth(rest);
    }
    case 'metrics': {
      const { runMetrics } = await import('./metrics.ts');
      return runMetrics(rest);
    }
    case 'errors': {
      const { runErrors } = await import('./errors.ts');
      return runErrors(rest);
    }
    case 'trace': {
      const { runTrace } = await import('./trace.ts');
      return runTrace(rest);
    }
    case 'audit': {
      const { runAudit } = await import('./audit.ts');
      return runAudit(rest);
    }
    case 'vault': {
      const { runVault } = await import('./vault.ts');
      return runVault(rest);
    }
    case undefined:
    case '--help':
    case '-h':
      printDebugHelp();
      return 0;
    default:
      process.stderr.write(`Unknown debug subcommand: ${sub}\n`);
      printDebugHelp();
      return 1;
  }
}
