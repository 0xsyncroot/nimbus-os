// loop.ts — SPEC-103: agent turn generator integrating plan detect, prompts, tools.
// SPEC-132: taskSpec / INTERNAL_PLAN removed. Plan-as-tool (TodoWriteTool) replaces it.
//           planDetector retained as NUDGE emitter only.

import { ErrorCode, NimbusError, classify } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { isAllowedInPlanMode } from '../permissions/mode.ts';
import { newToolUseId } from '../ir/helpers.ts';
import type {
  CanonicalBlock,
  CanonicalChunk,
  CanonicalMessage,
  ToolDefinition,
} from '../ir/types.ts';
import { buildSystemPrompt } from './prompts.ts';
import { loadWorkspaceMemory } from './workspaceMemory.ts';
import { detectPlanMode, renderPlanCue } from './planDetector.ts';
import { snapshotEnvironment, serializeEnvironment } from './environment.ts';
import {
  breakerKey,
  createBreaker,
  guardBreaker,
  type CircuitBreaker,
  type ErrorFamily,
} from './circuitBreaker.ts';
import { appendEvent, appendMessage } from '../storage/sessionStore.ts';
import { MAX_TOOL_ITERATIONS, type LoopOutput, type TurnContext, type TurnMetric } from './turn.ts';
import { getGlobalBus, type EventBus } from './events.ts';
import { TOPICS } from './eventTypes.ts';
import { createHash } from 'node:crypto';

function digestInput(input: unknown): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    return 'sha256:' + createHash('sha256').update(s).digest('hex').slice(0, 16);
  } catch {
    return 'sha256:unhashable';
  }
}

function publishSafe(bus: EventBus, topic: string, event: unknown): void {
  try {
    bus.publish(topic, event);
  } catch (err) {
    logger.warn({ err: (err as Error).message, topic }, 'event publish failed');
  }
}

/**
 * v0.3.4 (Bug B fix): peek the structured ErrorCode prefix out of a failed
 * ToolResult so the renderer can pick a locale-specific friendly sentence
 * instead of the generic "Tool failed — run with --verbose" fallback.
 *
 * Matches executor.ts errorBlock() format: `${ErrorCode}: ${JSON context}`.
 * Returns undefined on success or when the content doesn't follow the format
 * (e.g. handler wrote a raw string).
 */
function extractErrorCode(res: ToolResult): string | undefined {
  if (res.ok) return undefined;
  const text = typeof res.content === 'string' ? res.content : '';
  if (text.length === 0) return undefined;
  const m = text.match(/^([A-Z]_[A-Z0-9_]+)(?::|$)/);
  return m ? m[1] : undefined;
}

export interface ToolInvocation {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolUseId: string;
  ok: boolean;
  content: string | CanonicalBlock[];
  sideEffects: 'pure' | 'read' | 'write' | 'exec';
}

export interface ToolExecutor {
  listTools(): ToolDefinition[];
  execute(inv: ToolInvocation, signal: AbortSignal): Promise<ToolResult>;
  effectOf(name: string): 'pure' | 'read' | 'write' | 'exec';
}

// SPEC-121: budget guard — drop oldest turn pairs when prior messages exceed 70% of context.
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

function trimPriorMessages(
  msgs: CanonicalMessage[],
  maxContextTokens: number,
): CanonicalMessage[] {
  const budget = Math.floor(maxContextTokens * 0.7);
  let chars = 0;
  for (const m of msgs) {
    const content = typeof m.content === 'string'
      ? m.content
      : m.content.map((b) => ('text' in b ? (b as { text: string }).text : '')).join('');
    chars += content.length;
  }
  if (chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN <= budget) return msgs;
  // Drop oldest turn pairs (user+assistant) from the front until under budget
  const trimmed = [...msgs];
  while (trimmed.length >= 2 && chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN > budget) {
    const dropped = trimmed.splice(0, 2);
    for (const m of dropped) {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => ('text' in b ? (b as { text: string }).text : '')).join('');
      chars -= content.length;
    }
  }
  return trimmed;
}

export interface RunTurnOptions {
  ctx: TurnContext;
  userMessage: string;
  tools?: ToolExecutor;
  breaker?: CircuitBreaker;
  /** SPEC-121: prior conversation messages for cross-turn context rehydration. */
  priorMessages?: CanonicalMessage[];
}

function providerErrorFamily(code: ErrorCode): ErrorFamily | null {
  switch (code) {
    case ErrorCode.P_NETWORK: return 'P_NETWORK';
    case ErrorCode.P_5XX: return 'P_5XX';
    case ErrorCode.P_429: return 'P_429';
    case ErrorCode.P_AUTH: return 'P_AUTH';
    case ErrorCode.P_INVALID_REQUEST: return 'P_INVALID_REQUEST';
    default: return null;
  }
}

export async function* runTurn(opts: RunTurnOptions): AsyncGenerator<LoopOutput, void, void> {
  const { ctx, userMessage } = opts;
  const turnId = newToolUseId();
  const startedAt = Date.now();
  const breaker = opts.breaker ?? createBreaker();
  let iterations = 0;
  let outcome: 'ok' | 'error' | 'cancelled' = 'ok';
  let errorCode: string | undefined;

  const bus = getGlobalBus();

  try {
    const memory = await loadWorkspaceMemory(ctx.wsId);

    // Plan detection (SPEC-108)
    const planDecision = detectPlanMode(userMessage);
    if (planDecision.plan) {
      const heuristic = planDecision.matchedHeuristic ?? 'H1';
      yield {
        kind: 'plan_announce',
        reason: planDecision.reason,
        heuristic,
      };
      publishSafe(bus, TOPICS.session.planAnnounce, {
        type: TOPICS.session.planAnnounce,
        sessionId: ctx.sessionId,
        turnId,
        reason: planDecision.reason,
        heuristic,
        ts: Date.now(),
      });
      await appendEvent(ctx.wsId, ctx.sessionId, {
        ts: Date.now(),
        type: 'plan_announce',
        turnId,
        reason: planDecision.reason,
        heuristic,
      } as Omit<import('./sessionTypes.ts').StoredSessionEvent, 'eventId'>).catch(() => undefined);
    }

    // Environment snapshot (SPEC-109)
    const env = await snapshotEnvironment({ abort: ctx.abort.turn.signal });
    const envXml = serializeEnvironment(env);
    // SPEC-132: planDetector repurposed as NUDGE emitter.
    // planCue is a hint line injected into the system prompt when a complex task is detected,
    // signalling the model to consider calling TodoWrite. No out-of-band LLM spec generated.
    const planCue = renderPlanCue(planDecision);
    const caps = ctx.provider.capabilities();
    const systemBlocks = buildSystemPrompt({ memory, caps, planCue, environmentXml: envXml });

    const tools = opts.tools?.listTools();
    const maxCtxTokens = ctx.provider.capabilities().maxContextTokens;
    const prior = opts.priorMessages
      ? trimPriorMessages(opts.priorMessages, maxCtxTokens)
      : [];
    const conversation: CanonicalMessage[] = [
      ...prior,
      { role: 'user', content: [{ type: 'text', text: userMessage }] },
    ];

    // Persist user message
    await appendMessage(ctx.wsId, ctx.sessionId, conversation[0]!, turnId).catch((err) => {
      logger.warn({ err: (err as Error).message }, 'append user message failed');
    });
    await appendEvent(ctx.wsId, ctx.sessionId, {
      ts: Date.now(),
      type: 'user_msg' as const,
      text: userMessage,
    } as Omit<import('./sessionTypes.ts').StoredSessionEvent, 'eventId'>).catch(() => undefined);
    publishSafe(bus, TOPICS.session.userMsg, {
      type: TOPICS.session.userMsg,
      sessionId: ctx.sessionId,
      text: userMessage,
      ts: Date.now(),
    });

    // Agent iteration loop
    for (iterations = 0; iterations < MAX_TOOL_ITERATIONS; iterations++) {
      if (ctx.abort.turn.signal.aborted) {
        outcome = 'cancelled';
        break;
      }

      const providerId = ctx.provider.id;
      const bkKey = breakerKey(providerId, 'P_5XX');
      guardBreaker(breaker, bkKey);

      const stream = ctx.provider.stream(
        {
          messages: conversation,
          system: systemBlocks,
          tools: tools && tools.length > 0 ? tools : undefined,
          model: ctx.model,
          stream: true,
        },
        { signal: ctx.abort.provider.signal },
      );

      const assistantBlocks: CanonicalBlock[] = [];
      let textBuf = '';
      let finishedWithToolUse = false;
      const pendingToolUses: ToolInvocation[] = [];

      try {
        for await (const chunk of stream) {
          yield { kind: 'chunk', chunk };
          if (chunk.type === 'content_block_start') {
            if (chunk.block.type === 'text') {
              textBuf = chunk.block.text;
            } else if (chunk.block.type === 'tool_use') {
              pendingToolUses.push({ toolUseId: chunk.block.id, name: chunk.block.name, input: chunk.block.input });
            }
          } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text') {
            textBuf += chunk.delta.text ?? '';
          } else if (chunk.type === 'content_block_stop') {
            if (textBuf.length > 0) {
              assistantBlocks.push({ type: 'text', text: textBuf });
              textBuf = '';
            }
          } else if (chunk.type === 'usage') {
            const usageEvent: Record<string, unknown> = {
              type: TOPICS.session.usage,
              sessionId: ctx.sessionId,
              turnId,
              model: ctx.model,
              provider: ctx.provider.id,
              input: chunk.input,
              output: chunk.output,
              ts: Date.now(),
            };
            if (chunk.cacheRead !== undefined) usageEvent['cacheRead'] = chunk.cacheRead;
            if (chunk.cacheWrite !== undefined) usageEvent['cacheWrite'] = chunk.cacheWrite;
            publishSafe(bus, TOPICS.session.usage, usageEvent);
            const storedUsage: Record<string, unknown> = {
              ts: Date.now(),
              type: 'usage' as const,
              turnId,
              model: ctx.model,
              provider: ctx.provider.id,
              input: chunk.input,
              output: chunk.output,
            };
            if (chunk.cacheRead !== undefined) storedUsage['cacheRead'] = chunk.cacheRead;
            if (chunk.cacheWrite !== undefined) storedUsage['cacheWrite'] = chunk.cacheWrite;
            await appendEvent(ctx.wsId, ctx.sessionId, storedUsage as Omit<import('./sessionTypes.ts').StoredSessionEvent, 'eventId'>).catch(() => undefined);
          } else if (chunk.type === 'message_stop') {
            if (chunk.finishReason === 'tool_use') finishedWithToolUse = true;
            break;
          } else if (chunk.type === 'error') {
            throw new NimbusError(ErrorCode.P_INVALID_REQUEST, { reason: 'provider_error_chunk', message: chunk.message });
          }
        }
        breaker.record(bkKey, 'ok');
      } catch (err) {
        const code = err instanceof NimbusError ? err.code : classify(err);
        const fam = providerErrorFamily(code);
        if (fam) breaker.record(bkKey, fam);
        throw err instanceof NimbusError ? err : new NimbusError(code, { reason: 'provider_stream_failed' });
      }

      if (pendingToolUses.length > 0) {
        for (const inv of pendingToolUses) {
          assistantBlocks.push({ type: 'tool_use', id: inv.toolUseId, name: inv.name, input: inv.input });
        }
      }
      conversation.push({ role: 'assistant', content: assistantBlocks });
      await appendMessage(ctx.wsId, ctx.sessionId, conversation[conversation.length - 1]!, turnId, {
        isTurnBoundary: !finishedWithToolUse,
      }).catch((err) => logger.warn({ err: (err as Error).message }, 'persist assistant message failed'));

      // Extract combined assistant text for event publication.
      const assistantText = assistantBlocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (assistantText.length > 0) {
        publishSafe(bus, TOPICS.session.assistantMsg, {
          type: TOPICS.session.assistantMsg,
          sessionId: ctx.sessionId,
          turnId,
          text: assistantText,
          ts: Date.now(),
        });
        await appendEvent(ctx.wsId, ctx.sessionId, {
          ts: Date.now(),
          type: 'assistant_msg',
          turnId,
          text: assistantText,
        } as Omit<import('./sessionTypes.ts').StoredSessionEvent, 'eventId'>).catch(() => undefined);
      }

      if (!finishedWithToolUse || pendingToolUses.length === 0) break;
      if (!opts.tools) {
        throw new NimbusError(ErrorCode.T_CRASH, { reason: 'tool_use_without_executor' });
      }

      // Partition by side effects
      const pure: ToolInvocation[] = [];
      const serial: ToolInvocation[] = [];
      for (const inv of pendingToolUses) {
        const eff = opts.tools.effectOf(inv.name);
        if (eff === 'pure' || eff === 'read') pure.push(inv);
        else serial.push(inv);
      }

      const results: ToolResult[] = [];

      // SPEC-133: Defense-in-depth plan mode gate — checked at executor entry
      // before any tool dispatch. Non-whitelist tool in plan mode → T_PERMISSION + security event.
      if (ctx.mode === 'plan') {
        const blockedInvocations = pendingToolUses.filter((inv) => !isAllowedInPlanMode(inv.name));
        if (blockedInvocations.length > 0) {
          for (const inv of blockedInvocations) {
            results.push({
              toolUseId: inv.toolUseId,
              ok: false,
              content: new NimbusError(ErrorCode.T_PERMISSION, {
                tool: inv.name,
                reason: 'plan_mode_whitelist',
                hint: 'Exit plan mode first',
              }).message,
              sideEffects: 'exec' as const,
            });
            publishSafe(bus, TOPICS.security.event, {
              type: TOPICS.security.event,
              adapterId: ctx.sessionId,
              reason: `plan_mode_blocked:${inv.name}`,
              userId: ctx.wsId,
              ts: Date.now(),
            });
          }
          // Remove blocked invocations from pure/serial dispatch queues.
          const blockedIds = new Set(blockedInvocations.map((i) => i.toolUseId));
          pure.splice(0, pure.length, ...pure.filter((i) => !blockedIds.has(i.toolUseId)));
          serial.splice(0, serial.length, ...serial.filter((i) => !blockedIds.has(i.toolUseId)));
          if (pure.length === 0 && serial.length === 0) {
            // All blocked — push error blocks and continue to next iteration.
            const blockedResultBlocks: CanonicalBlock[] = results.map((r) => ({
              type: 'tool_result',
              toolUseId: r.toolUseId,
              content: r.content,
              isError: true,
            }));
            conversation.push({ role: 'user', content: blockedResultBlocks });
            await appendMessage(ctx.wsId, ctx.sessionId, conversation[conversation.length - 1]!, turnId).catch(() => undefined);
            continue;
          }
        }
      }

      const emitInvocation = (inv: ToolInvocation): void => {
        publishSafe(bus, TOPICS.session.toolUse, {
          type: TOPICS.session.toolUse,
          sessionId: ctx.sessionId,
          turnId,
          toolUseId: inv.toolUseId,
          name: inv.name,
          input: inv.input,
          ts: Date.now(),
        });
        appendEvent(ctx.wsId, ctx.sessionId, {
          ts: Date.now(),
          type: 'tool_invocation',
          turnId,
          toolUseId: inv.toolUseId,
          name: inv.name,
          inputDigest: digestInput(inv.input),
        } as Omit<import('./sessionTypes.ts').StoredSessionEvent, 'eventId'>).catch(() => undefined);
      };
      const emitResult = (inv: ToolInvocation, ok: boolean, ms: number): void => {
        publishSafe(bus, TOPICS.session.toolResult, {
          type: TOPICS.session.toolResult,
          sessionId: ctx.sessionId,
          turnId,
          toolUseId: inv.toolUseId,
          name: inv.name,
          ok,
          ms,
          ts: Date.now(),
        });
        appendEvent(ctx.wsId, ctx.sessionId, {
          ts: Date.now(),
          type: 'tool_result',
          turnId,
          toolUseId: inv.toolUseId,
          name: inv.name,
          ok,
          ms,
        } as Omit<import('./sessionTypes.ts').StoredSessionEvent, 'eventId'>).catch(() => undefined);
      };

      // Concurrent read-only
      if (pure.length > 0) {
        for (const inv of pure) {
          // v0.3.4 (Bug A fix): propagate `args` so the renderer can humanize
          // the invocation even if no pre-computed humanLabel is supplied.
          yield {
            kind: 'tool_start',
            toolUseId: inv.toolUseId,
            name: inv.name,
            args: (inv.input ?? {}) as Record<string, unknown>,
          };
          emitInvocation(inv);
        }
        const started = Date.now();
        const parallel = await Promise.all(
          pure.map((inv) => opts.tools!.execute(inv, ctx.abort.tool.signal).catch((err): ToolResult => ({
            toolUseId: inv.toolUseId,
            ok: false,
            content: (err as Error).message,
            sideEffects: opts.tools!.effectOf(inv.name),
          }))),
        );
        for (let i = 0; i < parallel.length; i++) {
          const res = parallel[i]!;
          const inv = pure[i]!;
          results.push(res);
          const ms = Date.now() - started;
          const endEvt = {
            kind: 'tool_end' as const,
            toolUseId: res.toolUseId,
            ok: res.ok,
            ms,
          };
          // v0.3.4 (Bug B fix): surface the structured error code so the
          // renderer can emit a locale-specific friendly sentence instead of
          // the generic "Tool failed — run with --verbose" fallback.
          const code = extractErrorCode(res);
          yield code ? { ...endEvt, errorCode: code } : endEvt;
          emitResult(inv, res.ok, ms);
        }
      }

      // Serial write/exec
      for (const inv of serial) {
        yield {
          kind: 'tool_start',
          toolUseId: inv.toolUseId,
          name: inv.name,
          args: (inv.input ?? {}) as Record<string, unknown>,
        };
        emitInvocation(inv);
        const started = Date.now();
        try {
          const res = await opts.tools.execute(inv, ctx.abort.tool.signal);
          results.push(res);
          const ms = Date.now() - started;
          const endEvt = {
            kind: 'tool_end' as const,
            toolUseId: res.toolUseId,
            ok: res.ok,
            ms,
          };
          const code = extractErrorCode(res);
          yield code ? { ...endEvt, errorCode: code } : endEvt;
          emitResult(inv, res.ok, ms);
        } catch (err) {
          results.push({
            toolUseId: inv.toolUseId,
            ok: false,
            content: (err as Error).message,
            sideEffects: opts.tools.effectOf(inv.name),
          });
          const ms = Date.now() - started;
          const code = err instanceof NimbusError ? err.code : undefined;
          yield {
            kind: 'tool_end',
            toolUseId: inv.toolUseId,
            ok: false,
            ms,
            ...(code !== undefined ? { errorCode: code } : {}),
          };
          emitResult(inv, false, ms);
        }
      }

      // Feed tool_result blocks back
      const resultBlocks: CanonicalBlock[] = results.map((r) => ({
        type: 'tool_result',
        toolUseId: r.toolUseId,
        content: r.content,
        isError: !r.ok,
      }));
      conversation.push({ role: 'user', content: resultBlocks });
      await appendMessage(ctx.wsId, ctx.sessionId, conversation[conversation.length - 1]!, turnId).catch(() => undefined);
    }

    if (iterations >= MAX_TOOL_ITERATIONS) {
      throw new NimbusError(ErrorCode.T_ITERATION_CAP, { iterations, max: MAX_TOOL_ITERATIONS });
    }
  } catch (err) {
    if (ctx.abort.turn.signal.aborted) outcome = 'cancelled';
    else outcome = 'error';
    if (err instanceof NimbusError) errorCode = err.code;
    else errorCode = classify(err);
    const metric: TurnMetric = {
      turnId,
      sessionId: ctx.sessionId,
      outcome,
      ms: Date.now() - startedAt,
      iterations,
      model: ctx.model,
    };
    if (errorCode !== undefined) metric.errorCode = errorCode;
    yield { kind: 'turn_end', metric };
    publishSafe(bus, TOPICS.session.turnComplete, {
      type: TOPICS.session.turnComplete,
      sessionId: ctx.sessionId,
      turnId,
      ok: false,
      ms: metric.ms,
    });
    if (outcome === 'error') {
      publishSafe(bus, TOPICS.session.error, {
        type: TOPICS.session.error,
        sessionId: ctx.sessionId,
        code: errorCode ?? 'T_CRASH',
        ts: Date.now(),
      });
    }
    await appendEvent(ctx.wsId, ctx.sessionId, {
      ts: Date.now(),
      type: 'turn_complete',
      turnId,
      ok: false,
      ms: metric.ms,
    } as Omit<import('./sessionTypes.ts').StoredSessionEvent, 'eventId'>).catch(() => undefined);
    ctx.abort.dispose();
    if (outcome === 'error') throw err;
    return;
  }
  const metric: TurnMetric = {
    turnId,
    sessionId: ctx.sessionId,
    outcome,
    ms: Date.now() - startedAt,
    iterations,
    model: ctx.model,
  };
  if (errorCode !== undefined) metric.errorCode = errorCode;
  yield { kind: 'turn_end', metric };
  publishSafe(bus, TOPICS.session.turnComplete, {
    type: TOPICS.session.turnComplete,
    sessionId: ctx.sessionId,
    turnId,
    ok: outcome === 'ok',
    ms: metric.ms,
  });
  await appendEvent(ctx.wsId, ctx.sessionId, {
    ts: Date.now(),
    type: 'turn_complete',
    turnId,
    ok: outcome === 'ok',
    ms: metric.ms,
  } as Omit<import('./sessionTypes.ts').StoredSessionEvent, 'eventId'>).catch(() => undefined);
  ctx.abort.dispose();
}

export { MAX_TOOL_ITERATIONS };
