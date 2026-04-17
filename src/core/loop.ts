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

/**
 * v0.3.16: repair `tool_use` → `tool_result` pairing in the conversation we
 * replay to the provider. Both Anthropic and OpenAI REJECT requests where
 * an assistant `tool_use` block has no matching `tool_result` — Anthropic
 * returns `400 tool_use_id ... was not followed by a tool_result`, OpenAI
 * returns `400 messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'`. The REPL can persist an orphan assistant
 * turn if the process was killed (Ctrl-C twice, OOM, crash) between
 * `appendMessage(assistant-with-tool_use)` (loop.ts ~300) and
 * `appendMessage(user-with-tool_result)` (loop.ts ~519). It can also be
 * produced by a sub-agent or Telegram channel that abandons a turn.
 *
 * This sanitizer runs on every replay:
 *   1. walk messages left-to-right, track open tool_use ids.
 *   2. when we see a user `tool_result` block referring to an unknown id,
 *      drop that block (the tool_use was already cleared somehow).
 *   3. at the very end, for any still-open ids, inject a synthetic user
 *      message with `tool_result` stubs (isError:true, content:"interrupted")
 *      immediately after their parent assistant msg so the pair is closed.
 *
 * Mirrors Claude Code's `yieldMissingToolResultBlocks` (src/query.ts:123).
 *
 * KEPT PURE: takes and returns a NEW array; never mutates input blocks.
 * Safe to call repeatedly (idempotent when already-paired).
 */
export function sanitizePriorMessages(msgs: CanonicalMessage[]): CanonicalMessage[] {
  if (msgs.length === 0) return msgs;

  // Pass 1: collect all tool_use ids that appear in assistant messages,
  // and all tool_result ids that appear in user messages. Detect orphans.
  const resultIdsSeen = new Set<string>();
  for (const m of msgs) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') resultIdsSeen.add(b.toolUseId);
    }
  }

  // Pass 2: rebuild messages
  //   - drop tool_result blocks whose id was never emitted by any prior assistant
  //   - track open tool_use ids; after this pass, for every assistant that
  //     still has open ids we either (a) merge stubs into the very next user
  //     message if it is itself a tool_result container, or (b) insert a
  //     fresh synthetic user message right after the assistant.
  const emittedIds = new Set<string>();
  const out: CanonicalMessage[] = [];
  // assistant index in `out` → ids that have not been paired yet.
  const pendingByAssistantIdx = new Map<number, string[]>();
  // assistant index in `out` → index in `out` of the FIRST user-tool_result
  // message that immediately follows it (only set if that user msg exists
  // AND carries at least one tool_result block). This is where we prefer
  // to merge synthetic stubs so the pair stays in the same turn.
  const followingResultMsgIdx = new Map<number, number>();
  let lastAssistantIdx = -1;

  for (const m of msgs) {
    if (typeof m.content === 'string') {
      out.push(m);
      lastAssistantIdx = -1;
      continue;
    }

    if (m.role === 'assistant') {
      const kept: CanonicalBlock[] = [];
      const assistantToolUseIds: string[] = [];
      for (const b of m.content) {
        kept.push(b);
        if (b.type === 'tool_use') {
          emittedIds.add(b.id);
          assistantToolUseIds.push(b.id);
        }
      }
      if (kept.length === 0) {
        // drop empty assistant msg (provider rejects)
        lastAssistantIdx = -1;
        continue;
      }
      const idx = out.length;
      out.push({ role: 'assistant', content: kept });
      if (assistantToolUseIds.length > 0) {
        pendingByAssistantIdx.set(idx, [...assistantToolUseIds]);
      }
      lastAssistantIdx = idx;
      continue;
    }

    if (m.role === 'user') {
      const kept: CanonicalBlock[] = [];
      let hasToolResultBlock = false;
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          if (!emittedIds.has(b.toolUseId)) {
            // orphan — drop it (no matching tool_use upstream).
            continue;
          }
          // mark paired: remove from every pending map entry.
          for (const ids of pendingByAssistantIdx.values()) {
            const pi = ids.indexOf(b.toolUseId);
            if (pi >= 0) ids.splice(pi, 1);
          }
          kept.push(b);
          hasToolResultBlock = true;
        } else {
          kept.push(b);
        }
      }
      if (kept.length === 0) {
        // drop empty user msg; do NOT clear lastAssistantIdx — we still
        // want synthetic stubs to attach to the original assistant.
        continue;
      }
      const userIdx = out.length;
      out.push({ role: 'user', content: kept });
      // If this user message immediately follows an assistant and carries
      // at least one tool_result block, remember it as the merge target.
      if (hasToolResultBlock && lastAssistantIdx === userIdx - 1) {
        followingResultMsgIdx.set(lastAssistantIdx, userIdx);
      }
      lastAssistantIdx = -1;
      continue;
    }

    // system messages (should be built from buildSystemPrompt but defensively preserve)
    out.push(m);
    lastAssistantIdx = -1;
  }

  // Pass 3: close still-pending tool_use ids.
  //   Preferred: merge synthetic blocks INTO the adjacent user-tool_result
  //   message (same turn — what the provider expects).
  //   Fallback: insert a fresh synthetic user message right after the
  //   assistant. Walk indices in reverse so splicing doesn't shift earlier
  //   indices.
  const fallbackEntries: Array<[number, string[]]> = [];
  for (const [idx, ids] of pendingByAssistantIdx.entries()) {
    if (ids.length === 0) continue;
    const targetIdx = followingResultMsgIdx.get(idx);
    if (targetIdx !== undefined) {
      const target = out[targetIdx]!;
      const targetBlocks = Array.isArray(target.content) ? target.content : [];
      const stubBlocks: CanonicalBlock[] = ids.map((id) => ({
        type: 'tool_result',
        toolUseId: id,
        content: 'tool call interrupted — session resumed without a completed result',
        isError: true,
      }));
      out[targetIdx] = { role: 'user', content: [...targetBlocks, ...stubBlocks] };
    } else {
      fallbackEntries.push([idx, ids]);
    }
  }
  fallbackEntries.sort((a, b) => b[0] - a[0]);
  for (const [idx, ids] of fallbackEntries) {
    const stubBlocks: CanonicalBlock[] = ids.map((id) => ({
      type: 'tool_result',
      toolUseId: id,
      content: 'tool call interrupted — session resumed without a completed result',
      isError: true,
    }));
    out.splice(idx + 1, 0, { role: 'user', content: stubBlocks });
  }

  return out;
}

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
  // v0.3.16: hoisted so the catch block can sweep for orphan tool_use blocks
  // and persist synthetic tool_result stubs before re-throwing. Without this,
  // a crash between `conversation.push(assistant)` and
  // `conversation.push(user-with-tool_result)` would leak an orphan into the
  // session JSONL, which the NEXT turn then replays → provider 400.
  const conversation: CanonicalMessage[] = [];

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
    // v0.3.16: sanitize BEFORE trim so trim acts on already-paired history.
    // Sanitize AFTER trim as defense: trim drops from the front in (user,assistant)
    // pairs, which can strand a tool_result whose matching tool_use just left
    // or orphan a new-frontier tool_use whose result is still in the trimmed
    // window. Two passes are idempotent.
    const prior = opts.priorMessages
      ? sanitizePriorMessages(
          trimPriorMessages(sanitizePriorMessages(opts.priorMessages), maxCtxTokens),
        )
      : [];
    conversation.push(
      ...prior,
      { role: 'user', content: [{ type: 'text', text: userMessage }] },
    );

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

    // v0.3.16: close any orphan tool_use left on disk. Without this, the
    // session JSONL persists an assistant message with `tool_use` blocks
    // that never get a matching `tool_result`, and the NEXT REPL turn
    // replays it → provider returns 400. Walk `conversation` (in-memory
    // snapshot of everything the turn pushed this iteration) and write
    // synthetic tool_result stubs for every un-answered id. Safe in the
    // common case because when the turn completes normally we push the
    // result blocks at loop.ts ~643 before reaching this catch.
    try {
      const openToolUseIds: string[] = [];
      const paired = new Set<string>();
      for (const m of conversation) {
        if (typeof m.content === 'string') continue;
        if (m.role === 'assistant') {
          for (const b of m.content) {
            if (b.type === 'tool_use') openToolUseIds.push(b.id);
          }
        } else if (m.role === 'user') {
          for (const b of m.content) {
            if (b.type === 'tool_result') paired.add(b.toolUseId);
          }
        }
      }
      const unpaired = openToolUseIds.filter((id) => !paired.has(id));
      if (unpaired.length > 0) {
        const stubMsg: CanonicalMessage = {
          role: 'user',
          content: unpaired.map((id) => ({
            type: 'tool_result',
            toolUseId: id,
            content: outcome === 'cancelled'
              ? 'tool call cancelled by user (Ctrl-C)'
              : `tool call failed before completion: ${errorCode ?? 'unknown'}`,
            isError: true,
          })),
        };
        await appendMessage(ctx.wsId, ctx.sessionId, stubMsg, turnId, {
          isTurnBoundary: true,
        }).catch(() => undefined);
      }
    } catch {
      // best-effort; never let sanitizer raise over the original error.
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
