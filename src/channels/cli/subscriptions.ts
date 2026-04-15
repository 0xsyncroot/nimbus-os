// subscriptions.ts — wire cost ledger + audit log to the SPEC-118 event bus.
// Called from startRepl() so subscribers live for the REPL session.

import { logger } from '../../observability/logger.ts';
import { appendAudit, digestInput } from '../../observability/auditLog.ts';
import type { AuditEntry } from '../../observability/auditTypes.ts';
import { getGlobalBus, type Disposable } from '../../core/events.ts';
import { TOPICS } from '../../core/eventTypes.ts';
import { recordCost } from '../../cost/accountant.ts';

interface UsageEvent {
  type: string;
  sessionId: string;
  turnId: string;
  model: string;
  provider: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  ts: number;
}

interface ToolEvent {
  type: string;
  sessionId: string;
  turnId: string;
  toolUseId: string;
  name: string;
  input?: unknown;
  ok?: boolean;
  ms?: number;
  ts: number;
}

export interface WireOpts {
  workspaceId: string;
  channel?: 'cli' | 'http' | 'ws' | 'telegram' | 'slack';
}

export function wireBusSubscribers(opts: WireOpts): Disposable {
  const bus = getGlobalBus();
  const channel = opts.channel ?? 'cli';
  const disposers: Disposable[] = [];

  disposers.push(
    bus.subscribe(TOPICS.session.usage, async (raw: unknown) => {
      const ev = raw as UsageEvent;
      try {
        await recordCost({
          workspaceId: opts.workspaceId,
          sessionId: ev.sessionId,
          turnId: ev.turnId,
          provider: ev.provider,
          model: ev.model,
          channel,
          usage: {
            inputTokens: ev.input,
            outputTokens: ev.output,
            cacheReadTokens: ev.cacheRead ?? 0,
            cacheWriteTokens: ev.cacheWrite ?? 0,
            reasoningTokens: 0,
          },
          ts: ev.ts,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'cost recordCost failed');
      }
    }),
  );

  disposers.push(
    bus.subscribe(TOPICS.session.toolUse, async (raw: unknown) => {
      const ev = raw as ToolEvent;
      const entry: AuditEntry = {
        schemaVersion: 1,
        ts: ev.ts,
        sessionId: ev.sessionId,
        kind: 'tool_call',
        toolName: ev.name,
        inputDigest: digestInput(ev.input ?? {}),
        outcome: 'ok',
      };
      try {
        await appendAudit(entry);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'audit append (tool_use) failed');
      }
    }),
  );

  disposers.push(
    bus.subscribe(TOPICS.session.toolResult, async (raw: unknown) => {
      const ev = raw as ToolEvent;
      const entry: AuditEntry = {
        schemaVersion: 1,
        ts: ev.ts,
        sessionId: ev.sessionId,
        kind: 'tool_call',
        toolName: ev.name,
        inputDigest: digestInput({ toolUseId: ev.toolUseId }),
        outcome: ev.ok === false ? 'error' : 'ok',
      };
      try {
        await appendAudit(entry);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'audit append (tool_result) failed');
      }
    }),
  );

  return () => {
    for (const d of disposers) {
      try { d(); } catch { /* swallow */ }
    }
  };
}
