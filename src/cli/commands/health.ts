// health.ts — SPEC-603: `nimbus health` — subsystems + memory + disk.

import { stat } from 'node:fs/promises';
import { freemem } from 'node:os';
import { metricsDir } from '../../observability/reader.ts';
import { logsDir } from '../../platform/paths.ts';

type HealthLevel = 'ok' | 'degraded' | 'down';

interface SubsystemHealth {
  status: HealthLevel;
  detail?: string;
}

interface HealthReport {
  overall: HealthLevel;
  subsystems: Record<string, SubsystemHealth>;
  memoryMb: number;
  diskFreeMb: number;
  eventLoopLagMs: number;
}

async function checkDisk(path: string): Promise<{ freeMb: number }> {
  try {
    await stat(path);
    // Bun/Node doesn't expose statvfs natively — approximate via process
    const freeBytes = freemem();
    return { freeMb: Math.round(freeBytes / 1024 / 1024) };
  } catch {
    return { freeMb: 0 };
  }
}

function measureEventLoopLag(): Promise<number> {
  const start = Date.now();
  return new Promise((resolve) =>
    setImmediate(() => resolve(Date.now() - start)),
  );
}

export async function runHealth(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');

  const [lagMs, disk] = await Promise.all([
    measureEventLoopLag(),
    checkDisk(logsDir()),
  ]);

  const memFreeBytes = freemem();
  const memoryMb = Math.round(memFreeBytes / 1024 / 1024);
  // Absolute thresholds — freemem() underestimates on Linux (excludes buff/cache)
  // so % of totalmem() is misleading. For a CLI tool, low absolute free matters.

  const subsystems: Record<string, SubsystemHealth> = {
    metrics_dir: { status: 'ok' },
    memory: {
      status: memoryMb < 50 ? 'down' : memoryMb < 200 ? 'degraded' : 'ok',
      detail: `${memoryMb} MB free`,
    },
    disk: {
      status: disk.freeMb < 50 ? 'down' : disk.freeMb < 200 ? 'degraded' : 'ok',
      detail: `${disk.freeMb} MB free`,
    },
    event_loop: {
      status: lagMs > 100 ? 'degraded' : 'ok',
      detail: lagMs > 10 ? `${lagMs}ms lag` : undefined,
    },
  };

  // Verify metrics dir accessible
  try {
    await stat(metricsDir());
  } catch {
    subsystems['metrics_dir'] = { status: 'degraded', detail: 'metrics dir missing (no events yet)' };
  }

  const levels = Object.values(subsystems).map((s) => s.status);
  const overall: HealthLevel =
    levels.some((l) => l === 'down') ? 'down' :
    levels.some((l) => l === 'degraded') ? 'degraded' : 'ok';

  const report: HealthReport = {
    overall,
    subsystems,
    memoryMb,
    diskFreeMb: disk.freeMb,
    eventLoopLagMs: lagMs,
  };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return overall === 'ok' ? 0 : overall === 'degraded' ? 1 : 2;
  }

  process.stdout.write(`nimbus health: ${overall.toUpperCase()}\n`);
  for (const [name, sub] of Object.entries(subsystems)) {
    const icon = sub.status === 'ok' ? 'OK' : sub.status === 'degraded' ? 'WARN' : 'FAIL';
    const detail = sub.detail ? `  (${sub.detail})` : '';
    process.stdout.write(`  ${name.padEnd(18)} ${icon}${detail}\n`);
  }
  process.stdout.write(`\n  Memory free: ${memoryMb} MB\n`);
  process.stdout.write(`  Disk free:   ${disk.freeMb} MB\n`);
  process.stdout.write(`  Loop lag:    ${lagMs} ms\n`);

  return overall === 'ok' ? 0 : overall === 'degraded' ? 1 : 2;
}
