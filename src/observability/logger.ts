// logger.ts — minimal pino setup used across nimbus modules.
// v0.3.8 URGENT: route pino output to ~/.nimbus/logs/nimbus.log by default
// (was leaking raw JSON lines to user stdout). stdout/stderr only receive
// the friendly messages printed by `errorFormatCli.ts`/`errorFormat.ts`.

import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';
import { nimbusHome } from '../platform/paths.ts';

const level = process.env['NIMBUS_LOG_LEVEL']
  ?? (process.env['NODE_ENV'] === 'test' ? 'silent' : 'info');

/** NIMBUS_LOG_STDOUT=1 restores the legacy "pretty-print-ish JSON to stdout"
 *  behaviour for local debugging. By default, production + binary users
 *  never see raw pino output. */
const writeToStdout = process.env['NIMBUS_LOG_STDOUT'] === '1';

function fileDestination(): ReturnType<typeof createWriteStream> | null {
  try {
    const logFile = `${nimbusHome()}/logs/nimbus.log`;
    mkdirSync(dirname(logFile), { recursive: true });
    // appending stream; pino writes NDJSON lines to it
    return createWriteStream(logFile, { flags: 'a' });
  } catch {
    // If we cannot open the file (e.g. read-only FS), silently fall back
    // to a sink that discards output. stdout is NEVER used as a fallback
    // because that is the exact bug we fixed.
    return null;
  }
}

function buildLogger(): ReturnType<typeof pino> {
  if (writeToStdout) {
    return pino({ name: 'nimbus', level });
  }
  const dest = fileDestination();
  if (!dest) {
    // Null sink — log events go nowhere user-visible.
    return pino({ name: 'nimbus', level: 'silent' });
  }
  return pino({ name: 'nimbus', level }, dest);
}

export const logger = buildLogger();

export type Logger = typeof logger;
