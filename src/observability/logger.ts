// logger.ts — minimal pino setup used across nimbus modules.
// Central logger: pretty in dev, JSON in prod. Level via NIMBUS_LOG_LEVEL.

import pino from 'pino';

const level = process.env['NIMBUS_LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'test' ? 'silent' : 'info');

export const logger = pino({
  name: 'nimbus',
  level,
});

export type Logger = typeof logger;
